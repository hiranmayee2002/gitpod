// Copyright (c) 2021 Gitpod GmbH. All rights reserved.
// Licensed under the GNU Affero General Public License (AGPL).
// See License-AGPL.txt in the project root for license information.

package wsmanagermk2

import (
	"github.com/gitpod-io/gitpod/installer/pkg/common"

	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

func role(ctx *common.RenderContext) ([]runtime.Object, error) {
	labels := common.DefaultLabels(Component)

	return []runtime.Object{
		&rbacv1.Role{
			TypeMeta: common.TypeMetaRole,
			ObjectMeta: metav1.ObjectMeta{
				Name:      Component,
				Namespace: ctx.Namespace,
				Labels:    labels,
			},
			Rules: []rbacv1.PolicyRule{
				{
					APIGroups: []string{""},
					Resources: []string{"pods"},
					Verbs: []string{
						"create",
						"delete",
						"get",
						"list",
						"patch",
						"update",
						"watch",
					},
				},
				{
					Verbs:     []string{"get"},
					APIGroups: []string{""},
					Resources: []string{"pod/status"},
				},
				{
					APIGroups: []string{"workspace.gitpod.io"},
					Resources: []string{"workspaces"},
					Verbs: []string{
						"create",
						"delete",
						"get",
						"list",
						"patch",
						"update",
						"watch",
					},
				},
				{
					Verbs:     []string{"update"},
					APIGroups: []string{"workspace.gitpod.io"},
					Resources: []string{"workspaces/finalizers"},
				},
				{
					APIGroups: []string{"workspace.gitpod.io"},
					Resources: []string{"workspaces/status"},
					Verbs: []string{
						"get",
						"patch",
						"update",
					},
				},
				{
					APIGroups: []string{"workspace.gitpod.io"},
					Resources: []string{"snapshots"},
					Verbs: []string{
						"create",
						"delete",
						"get",
						"list",
						"watch",
					},
				},
				{
					APIGroups: []string{"workspace.gitpod.io"},
					Resources: []string{"snapshots/status"},
					Verbs: []string{
						"get",
					},
				},
				// ConfigMap, Leases, and Events access is required for leader-election.
				{
					APIGroups: []string{""},
					Resources: []string{"configmaps"},
					Verbs: []string{
						"create",
						"delete",
						"get",
						"list",
						"patch",
						"update",
						"watch",
					},
				},
				{
					APIGroups: []string{"coordination.k8s.io"},
					Resources: []string{"leases"},
					Verbs: []string{
						"create",
						"delete",
						"get",
						"list",
						"patch",
						"update",
						"watch",
					},
				},
				{
					APIGroups: []string{""},
					Resources: []string{"events"},
					Verbs: []string{
						"create",
						"patch",
					},
				},
				{
					APIGroups: []string{""},
					Resources: []string{"secrets"},
					Verbs: []string{
						"create",
						"delete",
						"get",
						"list",
						"watch",
					},
				},
			},
		},
	}, nil
}
