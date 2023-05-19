/**
 * Copyright (c) 2020 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License.AGPL.txt in the project root for license information.
 */

import * as express from "express";
import * as passport from "passport";
import { injectable, postConstruct, inject } from "inversify";
import { log } from "@gitpod/gitpod-protocol/lib/util/logging";
import { TeamDB, UserDB } from "@gitpod/gitpod-db/lib";
import { Config } from "../config";
import { HostContextProvider } from "./host-context-provider";
import { AuthProvider, AuthFlow } from "./auth-provider";
import { TokenProvider } from "../user/token-provider";
import { AuthProviderService } from "./auth-provider-service";
import { UserService } from "../user/user-service";
import { increaseLoginCounter } from "../prometheus-metrics";
import { Strategy as JWTStrategy } from "passport-jwt";
import { SessionHandlerProvider } from "../session-handler";
import { decodeWithoutVerification } from "./jwt";
import * as jsonwebtoken from "jsonwebtoken";
import { User } from "@gitpod/gitpod-protocol";

@injectable()
export class Authenticator {
    protected passportInitialize: express.Handler;
    protected passportJWT: express.Handler;

    @inject(Config) protected readonly config: Config;
    @inject(UserDB) protected userDb: UserDB;
    @inject(TeamDB) protected teamDb: TeamDB;
    @inject(HostContextProvider) protected hostContextProvider: HostContextProvider;
    @inject(TokenProvider) protected readonly tokenProvider: TokenProvider;
    @inject(AuthProviderService) protected readonly authProviderService: AuthProviderService;
    @inject(UserService) protected readonly userService: UserService;

    @postConstruct()
    protected setup() {
        // Setup passport
        this.passportInitialize = passport.initialize();
        this.passportJWT = new JWTStrategy(
            {
                jwtFromRequest: (req: express.Request): string => {
                    const cookies = parseCookieHeader(req.headers.cookie || "");
                    const token = cookies[SessionHandlerProvider.getJWTCookieName(this.config)];
                    return token;
                },
                secretOrKeyProvider: (req: express.Request, rawJWT: string, done: (key: string) => void): void => {
                    const keypairs = [this.config.auth.pki.signing, ...this.config.auth.pki.validating];
                    const publicKeysByID = keypairs.reduce<{ [id: string]: string }>((byID, keypair) => {
                        byID[keypair.id] = keypair.publicKey;
                        return byID;
                    }, {});

                    // When we verify an encoded token, we first read the Key ID from the token header (without verifying the signature)
                    // and then lookup the appropriate key from out collection of available keys.
                    const decodedWithoutVerification = decodeWithoutVerification(rawJWT);
                    const keyID = decodedWithoutVerification.header.kid;

                    if (!keyID) {
                        throw new Error("JWT token does not contain kid (key id) property.");
                    }

                    if (!publicKeysByID[keyID]) {
                        throw new Error("JWT was signed with an unknown key id");
                    }

                    done(publicKeysByID[keyID]);
                },
            },
            (jwtPayload: jsonwebtoken.JwtPayload, done: (err: Error | null, user?: User | boolean) => void) => {
                this.userDb
                    .findUserById(jwtPayload.sub as string)
                    .then((user) => {
                        if (user) {
                            this.userService.onAfterUserLoad(user).then(() => done(null, user));
                        } else {
                            done(new Error(`User ${jwtPayload.sub} not found.`), false);
                        }
                    })
                    .catch((err) => {
                        done(err, false);
                    });
            },
        ); // this.passportSession = passport.session();
        passport.serializeUser<string>((user: User, done) => {
            if (user) {
                done(null, user.id);
            } else {
                log.error("(Authenticator) serializeUser called with undefined user.");
            }
        });
        passport.deserializeUser(async (id, done) => {
            try {
                let user = await this.userDb.findUserById(id as string);
                if (user) {
                    user = await this.userService.onAfterUserLoad(user);
                    done(null, user);
                } else {
                    done(new Error("User not found."));
                }
            } catch (err) {
                done(err);
            }
        });
    }

    get initHandlers(): express.Handler[] {
        return [
            this.passportInitialize, // adds `passport.user` to session
            this.passportJWT, // deserializes session user into  `req.user`
        ];
    }

    async init(app: express.Application) {
        this.initHandlers.forEach((handler) => app.use(handler));
        app.use(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
            await this.authCallbackHandler(req, res, next);
        });
    }
    protected async authCallbackHandler(req: express.Request, res: express.Response, next: express.NextFunction) {
        if (req.url.startsWith("/auth/")) {
            const hostContexts = this.hostContextProvider.getAll();
            for (const { authProvider } of hostContexts) {
                const authCallbackPath = authProvider.authCallbackPath;
                if (req.url.startsWith(authCallbackPath)) {
                    log.info(`Auth Provider Callback. Path: ${authCallbackPath}`);
                    await authProvider.callback(req, res, next);
                    return;
                }
            }
        }
        return next();
    }

    protected async getAuthProviderForHost(host: string): Promise<AuthProvider | undefined> {
        const hostContext = this.hostContextProvider.get(host);
        return hostContext && hostContext.authProvider;
    }

    async authenticate(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
        if (req.isAuthenticated()) {
            log.info({ sessionId: req.sessionID }, `User is already authenticated. Continue.`, { "login-flow": true });
            return next();
        }
        let returnTo: string | undefined = req.query.returnTo?.toString();
        if (returnTo) {
            log.info({ sessionId: req.sessionID }, `Stored returnTo URL: ${returnTo}`, { "login-flow": true });
        }
        // returnTo defaults to workspaces url
        const workspaceUrl = this.config.hostUrl.asDashboard().toString();
        returnTo = returnTo || workspaceUrl;
        const host: string = req.query.host?.toString() || "";
        const authProvider = host && (await this.getAuthProviderForHost(host));
        if (!host || !authProvider) {
            log.info({ sessionId: req.sessionID }, `Bad request: missing parameters.`, { "login-flow": true });
            res.redirect(this.getSorryUrl(`Bad request: missing parameters.`));
            return;
        }
        // Logins with organizational Git Auth is not permitted
        if (authProvider.info.organizationId) {
            log.info({ sessionId: req.sessionID }, `Login with "${host}" is not permitted.`, {
                "authorize-flow": true,
                ap: authProvider.info,
            });
            res.redirect(this.getSorryUrl(`Login with "${host}" is not permitted.`));
            return;
        }
        if (this.config.disableDynamicAuthProviderLogin && !authProvider.params.builtin) {
            log.info({ sessionId: req.sessionID }, `Auth Provider is not allowed.`, { ap: authProvider.info });
            res.redirect(this.getSorryUrl(`Login with ${authProvider.params.host} is not allowed.`));
            return;
        }
        if (!req.session) {
            // The session is missing entirely: count as client error
            increaseLoginCounter("failed_client", authProvider.info.host);
            log.info({}, `No session.`, { "login-flow": true });
            res.redirect(this.getSorryUrl(`No session found. Please refresh the browser.`));
            return;
        }

        if (!authProvider.info.verified && !(await this.isInSetupMode())) {
            increaseLoginCounter("failed", authProvider.info.host);
            log.info({ sessionId: req.sessionID }, `Login with "${host}" is not permitted.`, {
                "login-flow": true,
                ap: authProvider.info,
            });
            res.redirect(this.getSorryUrl(`Login with "${host}" is not permitted.`));
            return;
        }

        // prepare session
        await AuthFlow.attach(req.session, {
            host,
            returnTo,
        });
        // authenticate user
        authProvider.authorize(req, res, next);
    }
    protected async isInSetupMode() {
        const hasAnyStaticProviders = this.hostContextProvider
            .getAll()
            .some((hc) => hc.authProvider.params.builtin === true);
        if (hasAnyStaticProviders) {
            return false;
        }
        const noUser = (await this.userDb.getUserCount()) === 0;
        return noUser;
    }

    async deauthorize(req: express.Request, res: express.Response, next: express.NextFunction) {
        const user = req.user;
        if (!req.isAuthenticated() || !User.is(user)) {
            log.info({ sessionId: req.sessionID }, `User is not authenticated.`);
            res.redirect(this.getSorryUrl(`Not authenticated. Please login.`));
            return;
        }
        const returnTo: string = req.query.returnTo?.toString() || this.config.hostUrl.asDashboard().toString();
        const host: string | undefined = req.query.host?.toString();

        const authProvider = host && (await this.getAuthProviderForHost(host));

        if (!host || !authProvider) {
            log.warn({ sessionId: req.sessionID }, `Bad request: missing parameters.`);
            res.redirect(this.getSorryUrl(`Bad request: missing parameters.`));
            return;
        }

        try {
            await this.userService.deauthorize(user, authProvider.authProviderId);
            res.redirect(returnTo);
        } catch (error) {
            next(error);
            log.error({ sessionId: req.sessionID }, `Failed to disconnect a provider.`, error, {
                host,
                userId: user.id,
            });
            res.redirect(
                this.getSorryUrl(
                    `Failed to disconnect a provider: ${error && error.message ? error.message : "unknown reason"}`,
                ),
            );
        }
    }

    async authorize(req: express.Request, res: express.Response, next: express.NextFunction) {
        if (!req.session) {
            log.info({}, `No session.`, { "authorize-flow": true });
            res.redirect(this.getSorryUrl(`No session found. Please refresh the browser.`));
            return;
        }
        const user = req.user;
        if (!req.isAuthenticated() || !User.is(user)) {
            log.info({ sessionId: req.sessionID }, `User is not authenticated.`, { "authorize-flow": true });
            res.redirect(this.getSorryUrl(`Not authenticated. Please login.`));
            return;
        }
        const returnTo: string | undefined = req.query.returnTo?.toString();
        const host: string | undefined = req.query.host?.toString();
        const scopes: string = req.query.scopes?.toString() || "";
        const override = req.query.override === "true";
        const authProvider = host && (await this.getAuthProviderForHost(host));
        if (!returnTo || !host || !authProvider) {
            log.info({ sessionId: req.sessionID }, `Bad request: missing parameters.`, { "authorize-flow": true });
            res.redirect(this.getSorryUrl(`Bad request: missing parameters.`));
            return;
        }

        // For non-verified org auth provider, ensure user is an owner of the org
        if (!authProvider.info.verified && authProvider.info.organizationId) {
            const member = await this.teamDb.findTeamMembership(user.id, authProvider.info.organizationId);
            if (member?.role !== "owner") {
                log.info({ sessionId: req.sessionID }, `Authorization with "${host}" is not permitted.`, {
                    "authorize-flow": true,
                    ap: authProvider.info,
                });
                res.redirect(this.getSorryUrl(`Authorization with "${host}" is not permitted.`));
                return;
            }
        }

        // For non-verified, non-org auth provider, ensure user is the owner of the auth provider
        if (!authProvider.info.verified && !authProvider.info.organizationId && user.id !== authProvider.info.ownerId) {
            log.info({ sessionId: req.sessionID }, `Authorization with "${host}" is not permitted.`, {
                "authorize-flow": true,
                ap: authProvider.info,
            });
            res.redirect(this.getSorryUrl(`Authorization with "${host}" is not permitted.`));
            return;
        }

        // Ensure user is a member of the org
        if (authProvider.info.organizationId) {
            const member = await this.teamDb.findTeamMembership(user.id, authProvider.info.organizationId);
            if (!member) {
                log.info({ sessionId: req.sessionID }, `Authorization with "${host}" is not permitted.`, {
                    "authorize-flow": true,
                    ap: authProvider.info,
                });
                res.redirect(this.getSorryUrl(`Authorization with "${host}" is not permitted.`));
                return;
            }
        }

        // prepare session
        await AuthFlow.attach(req.session, { host, returnTo, overrideScopes: override });
        let wantedScopes = scopes
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        if (wantedScopes.length === 0) {
            if (authProvider.info.requirements) {
                wantedScopes = authProvider.info.requirements.default;
            }
        }
        // compute merged scopes
        if (!override) {
            const currentScopes = await this.getCurrentScopes(req.user, authProvider);
            wantedScopes = this.mergeScopes(currentScopes, wantedScopes);
            // in case user signed in with another identity, we need to ensure the merged scopes contain
            // all default needed to for proper authentication
            if (currentScopes.length === 0 && authProvider.info.requirements) {
                wantedScopes = this.mergeScopes(authProvider.info.requirements.default, wantedScopes);
            }
        }
        // authorize Gitpod
        log.info(
            { sessionId: req.sessionID },
            `(doAuthorize) wanted scopes (${override ? "overriding" : "merging"}): ${wantedScopes.join(",")}`,
        );
        authProvider.authorize(req, res, next, wantedScopes);
    }
    protected mergeScopes(a: string[], b: string[]) {
        const set = new Set(a);
        b.forEach((s) => set.add(s));
        return Array.from(set).sort();
    }
    protected async getCurrentScopes(user: any, authProvider: AuthProvider) {
        if (User.is(user)) {
            try {
                const token = await this.tokenProvider.getTokenForHost(user, authProvider.params.host);
                return token.scopes;
            } catch {
                // no token
            }
        }
        return [];
    }
    protected getSorryUrl(message: string) {
        return this.config.hostUrl.asSorry(message).toString();
    }
}

function parseCookieHeader(cookie: string): { [key: string]: string } {
    return cookie
        .split("; ")
        .map((keypair) => keypair.split("="))
        .reduce<{ [key: string]: string }>((aggregator, vals) => {
            const [key, value] = vals;
            aggregator[key] = value;
            return aggregator;
        }, {});
}
