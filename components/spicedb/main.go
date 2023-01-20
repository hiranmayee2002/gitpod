package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func main() {
	rootCmd.Execute()
}

var (
	workspacesFile string
	projectsFile   string
	teamsFile      string
)

func init() {
	rootCmd.PersistentFlags().StringVar(&workspacesFile, "workspaces-file", "", "path to workspaces file")
	rootCmd.PersistentFlags().StringVar(&projectsFile, "projects-file", "", "path to projects file")
	rootCmd.PersistentFlags().StringVar(&teamsFile, "teams-file", "", "path to teams file")

	rootCmd.AddCommand(transformCmd)
}

var (
	rootCmd = &cobra.Command{
		Use:   "cobra-cli",
		Short: "A generator for Cobra based Applications",
		Long: `Cobra is a CLI library for Go that empowers applications.
This application is a tool to generate the needed files
to quickly create a Cobra application.`,
	}

	transformCmd = &cobra.Command{
		Use: "transform",
		RunE: func(cmd *cobra.Command, args []string) error {
			return transform(workspacesFile, projectsFile, teamsFile)
		},
	}
)

type Workspace struct {
	ID      string `json:"id"`
	OwnerID string `json:"ownerId"`
}

func (w *Workspace) ToOwnerRelationship() string {
	return fmt.Sprintf("workspace:%s#owner@user:%s", w.ID, w.OwnerID)
}

// {"userId":"ddaa86e6-3aa2-44a7-bc9e-2f8c8c7324ac","role":"owner","teamId":"bce79c38-b850-4475-896a-e0a696abc5a5"}
type Team struct {
	TeamID string `json:"teamId"`
	UserID string `json:"userId"`
	Role   string `json:"role"`
}

func (t *Team) ToRelationship() string {
	return fmt.Sprintf("team:%s#%s@user:%s", t.TeamID, t.Role, t.UserID)
}

type Project struct {
	ID     string `json:"id"`
	TeamID string `json:"teamId"`
	UserID string `json:"userId"`
}

func (t *Project) ToRelationship() string {
	var relation string
	var subject string
	if t.TeamID != "" {
		relation = "team"
		subject = fmt.Sprintf("team:%s", t.TeamID)
	}
	if t.UserID != "" {
		relation = "user"
		subject = fmt.Sprintf("user:%s", t.UserID)
	}

	return fmt.Sprintf("project:%s#%s@%s", t.ID, relation, subject)
}

func transform(wsFilePath, projFilePath, teamsFilePath string) error {
	var relationships []string

	if wsFilePath != "" {
		workspaces, err := readWS(wsFilePath)
		if err != nil {
			return err
		}

		for _, w := range workspaces {
			relationships = append(relationships, w.ToOwnerRelationship())
		}
	}

	if teamsFilePath != "" {
		teams, err := readTeams(teamsFilePath)
		if err != nil {
			return err
		}

		for _, w := range teams {
			relationships = append(relationships, w.ToRelationship())
		}
	}

	if projFilePath != "" {
		projects, err := readProjects(projFilePath)
		if err != nil {
			return err
		}

		for _, p := range projects {
			relationships = append(relationships, p.ToRelationship())
		}
	}

	fmt.Fprintf(os.Stdout, "relationships: |-\n")

	for _, r := range relationships {
		fmt.Fprintf(os.Stdout, "  %s\n", r)
	}

	return nil
}

func readWS(filePath string) ([]Workspace, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}

	defer f.Close()

	var results []Workspace

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var ws Workspace
		if err := json.Unmarshal(scanner.Bytes(), &ws); err != nil {
			return nil, err
		}

		results = append(results, ws)
	}

	return results, nil
}

func readTeams(filePath string) ([]Team, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}

	defer f.Close()

	var results []Team

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var t Team
		if err := json.Unmarshal(scanner.Bytes(), &t); err != nil {
			return nil, err
		}

		results = append(results, t)
	}

	return results, nil
}

func readProjects(filePath string) ([]Project, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}

	defer f.Close()

	var results []Project

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var t Project
		if err := json.Unmarshal(scanner.Bytes(), &t); err != nil {
			return nil, err
		}

		results = append(results, t)
	}

	return results, nil
}