#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const defaults = {
  owner: "playsnack",
  repo: "playsnack",
  title: "playsnack Work Board",
};

const args = parseArgs(process.argv.slice(2));
const owner = args.owner ?? defaults.owner;
const repo = args.repo ?? defaults.repo;
const title = args.title ?? defaults.title;
const dryRun = args["dry-run"] === true;

const statusOptions = [
  {
    name: "Backlog",
    color: "GRAY",
    description: "Not ready yet.",
  },
  {
    name: "Ready",
    color: "BLUE",
    description: "Ready to pick up.",
  },
  {
    name: "In Progress",
    color: "YELLOW",
    description: "Actively being worked on.",
  },
  {
    name: "Review",
    color: "PURPLE",
    description: "Ready for review.",
  },
  {
    name: "Done",
    color: "GREEN",
    description: "Finished.",
  },
  {
    name: "Blocked",
    color: "RED",
    description: "Cannot progress until something changes.",
  },
];

const workTypeOptions = [
  {
    name: "Epic",
    color: "PURPLE",
    description: "Large outcome spanning stories.",
  },
  {
    name: "Story",
    color: "BLUE",
    description: "User-visible slice of value.",
  },
  {
    name: "Task",
    color: "YELLOW",
    description: "Concrete implementation or process work.",
  },
  {
    name: "Subtask",
    color: "GRAY",
    description: "Small child task under a task or story.",
  },
  {
    name: "Bug",
    color: "RED",
    description: "Broken or regressed behavior.",
  },
];

const fields = [
  {
    name: "Work Type",
    dataType: "SINGLE_SELECT",
    options: workTypeOptions.map((option) => option.name),
  },
  {
    name: "Priority",
    dataType: "SINGLE_SELECT",
    options: ["High", "Medium", "Low"],
  },
  {
    name: "Severity",
    dataType: "SINGLE_SELECT",
    options: ["Critical", "Major", "Minor"],
  },
  {
    name: "Area",
    dataType: "SINGLE_SELECT",
    options: [
      "snack-player",
      "snack-server",
      "bite-engine",
      "bite-layout",
      "bite-renderer",
      "snack-room",
      "content-templates",
      "docs-process",
      "infra-deploy",
    ],
  },
  {
    name: "Target Date",
    dataType: "DATE",
  },
];

main();

function main() {
  if (dryRun) {
    printPlan();
    return;
  }

  ensureGh();

  const project = findProject(owner, title) ?? createProject(owner, title);
  const projectNumber = project.number;

  if (!projectNumber) {
    throw new Error(`Could not determine project number for "${title}".`);
  }

  linkRepo(projectNumber, owner, repo);
  createMissingFields(projectNumber, owner, fields);
  configureStatusField(projectNumber, owner);
  configureWorkTypeField(projectNumber, owner);

  console.log("");
  console.log("Project ready:");
  console.log(project.url ?? `https://github.com/orgs/${owner}/projects/${projectNumber}`);
}

function printPlan() {
  console.log(`Would create or reuse org project: ${owner}/${title}`);
  console.log(`Would link repository: ${owner}/${repo}`);
  console.log(`Would ensure Status: ${statusOptions.map((option) => option.name).join(", ")}`);
  console.log(`Would ensure Work Type: ${workTypeOptions.map((option) => option.name).join(", ")}`);
  console.log("Would ensure project fields:");

  for (const field of fields) {
    const options = field.options ? ` (${field.options.join(", ")})` : "";
    console.log(`- ${field.name}: ${field.dataType}${options}`);
  }
}

function configureWorkTypeField(projectNumber, owner) {
  const workTypeField = getSingleSelectFields(projectNumber, owner).find(
    (field) => field.name === "Work Type",
  );

  if (!workTypeField) {
    console.log("! Work Type field not found; skipping work type configuration.");
    return;
  }

  const existingOptions = workTypeField.options ?? [];
  const existingByName = new Map(existingOptions.map((option) => [option.name, option]));

  const mergedOptions = workTypeOptions.map((option) => ({
    ...option,
    id: existingByName.get(option.name)?.id,
  }));

  runGraphql(mutationUpdateSingleSelectField(workTypeField.id, mergedOptions));
}

function configureStatusField(projectNumber, owner) {
  const statusField = getSingleSelectFields(projectNumber, owner).find(
    (field) => field.name === "Status",
  );

  if (!statusField) {
    console.log("! Status field not found; skipping status configuration.");
    return;
  }

  const existingOptions = statusField.options ?? [];
  const existingByName = new Map(existingOptions.map((option) => [option.name, option]));
  const todoOption = existingByName.get("Todo");

  const mergedOptions = statusOptions.map((option) => {
    const existing = existingByName.get(option.name);
    const renamedTodo = option.name === "Backlog" ? todoOption : null;
    return {
      ...option,
      id: existing?.id ?? renamedTodo?.id,
    };
  });

  runGraphql(mutationUpdateSingleSelectField(statusField.id, mergedOptions));
}

function getSingleSelectFields(projectNumber, owner) {
  const query = `
    query {
      organization(login: ${JSON.stringify(owner)}) {
        projectV2(number: ${Number(projectNumber)}) {
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  `;
  const output = runGraphql(query);
  return output.data.organization.projectV2.fields.nodes.filter((field) => field.id);
}

function mutationUpdateSingleSelectField(fieldId, options) {
  const optionInputs = options
    .map((option) => {
      const fields = [
        option.id ? `id: ${JSON.stringify(option.id)}` : null,
        `name: ${JSON.stringify(option.name)}`,
        `color: ${option.color}`,
        `description: ${JSON.stringify(option.description)}`,
      ].filter(Boolean);
      return `{ ${fields.join(", ")} }`;
    })
    .join(", ");

  return `
    mutation {
      updateProjectV2Field(input: {
        fieldId: ${JSON.stringify(fieldId)},
        singleSelectOptions: [${optionInputs}]
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField {
            name
          }
        }
      }
    }
  `;
}

function ensureGh() {
  run("gh", ["auth", "status"], { stdio: "pipe" });
}

function findProject(owner, title) {
  const output = runJson("gh", [
    "project",
    "list",
    "--owner",
    owner,
    "--limit",
    "100",
    "--format",
    "json",
  ]);
  return output.projects?.find((project) => project.title === title);
}

function createProject(owner, title) {
  return runJson("gh", [
    "project",
    "create",
    "--owner",
    owner,
    "--title",
    title,
    "--format",
    "json",
  ]);
}

function linkRepo(projectNumber, owner, repo) {
  runLenient("gh", [
    "project",
    "link",
    String(projectNumber),
    "--owner",
    owner,
    "--repo",
    `${owner}/${repo}`,
  ], isAlreadyDoneError);
}

function createMissingFields(projectNumber, owner, wantedFields) {
  const existing = runJson("gh", [
    "project",
    "field-list",
    String(projectNumber),
    "--owner",
    owner,
    "--format",
    "json",
  ]);
  const existingFields = existing.fields ?? existing.items ?? [];
  const existingNames = new Set(existingFields.map((field) => field.name));

  for (const field of wantedFields) {
    if (existingNames.has(field.name)) {
      console.log(`= field exists: ${field.name}`);
      continue;
    }

    const fieldArgs = [
      "project",
      "field-create",
      String(projectNumber),
      "--owner",
      owner,
      "--name",
      field.name,
      "--data-type",
      field.dataType,
    ];

    if (field.options) {
      fieldArgs.push("--single-select-options", field.options.join(","));
    }

    runLenient("gh", fieldArgs, isAlreadyDoneError);
  }
}

function runJson(command, args) {
  const output = run(command, args, { stdio: "pipe" });
  return JSON.parse(output);
}

function runGraphql(query) {
  return runJson("gh", ["api", "graphql", "-f", `query=${query}`]);
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(" ");
  console.log(`$ ${printable}`);

  if (dryRun) {
    return "{}";
  }

  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
  });
}

function runLenient(command, args, canIgnore) {
  const printable = [command, ...args].join(" ");
  console.log(`$ ${printable}`);

  if (dryRun) {
    return "";
  }

  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const stderr = error.stderr?.toString() ?? "";
    const stdout = error.stdout?.toString() ?? "";
    const message = `${stdout}\n${stderr}\n${error.message}`;

    if (canIgnore(message)) {
      console.log(`= already done; continuing`);
      return "";
    }

    process.stdout.write(stdout);
    process.stderr.write(stderr);
    throw error;
  }
}

function isAlreadyDoneError(message) {
  return /already|taken|exists|linked/i.test(message);
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}
