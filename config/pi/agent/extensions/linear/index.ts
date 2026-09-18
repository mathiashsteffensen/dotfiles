import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	addComment,
	createIssue,
	createIssueRelation,
	deleteIssueRelation,
	getIssue,
	LINEAR_SECURITY_URL,
	listIssueLabels,
	listIssueRelations,
	listIssues,
	listTeams,
	saveKeychainApiKey,
	updateIssue,
} from "./client.ts";

const LIMIT = Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum results to return (default: 20)" }));
const CURSOR = Type.Optional(Type.String({ description: "Pagination cursor returned by an earlier call" }));

function required(value: string, name: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${name} must not be empty`);
	return trimmed;
}

function optional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function optionalIds(value: string[] | undefined, name: string): string[] | undefined {
	return value === undefined ? undefined : value.map((id, index) => required(id, `${name}[${index}]`));
}

const ISSUE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

async function resolveIssueId(value: string, signal?: AbortSignal): Promise<string> {
	const issueId = required(value, "issueId");
	return ISSUE_UUID.test(issueId) ? issueId : (await getIssue(issueId, signal)).id;
}

const OUTPUT_LIMITS = " Output is limited to 50KB or 2000 lines; truncated results include a path to the full JSON.";

async function result(operation: string, value: unknown) {
	const json = JSON.stringify(value, null, 2);
	const output = truncateHead(json);
	let text = output.content;
	let fullOutputPath: string | undefined;
	if (output.truncated) {
		const directory = await mkdtemp(join(tmpdir(), "pi-linear-"));
		fullOutputPath = join(directory, "output.json");
		const path = fullOutputPath;
		await withFileMutationQueue(path, () => writeFile(path, json, { encoding: "utf8", mode: 0o600 }));
		text += `\n\n[Output truncated: ${output.outputLines} of ${output.totalLines} lines, ${output.outputBytes} of ${output.totalBytes} bytes. Full output: ${fullOutputPath}]`;
	}
	return {
		content: [{ type: "text" as const, text }],
		details: { operation, ...(fullOutputPath ? { fullOutputPath } : {}) },
	};
}

class SecretInput extends Input {
	render(width: number): string[] {
		const value = this.getValue();
		if (!value) return super.render(width);
		this.setValue("•".repeat([...value].length));
		const lines = super.render(width);
		this.setValue(value);
		return lines;
	}
}

async function promptApiKey(ctx: ExtensionContext): Promise<string | undefined> {
	if (ctx.mode !== "tui") throw new Error("Run /linear-login from an interactive Pi session");

	let dismiss: (() => void) | undefined;
	const onAbort = () => dismiss?.();
	ctx.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await ctx.ui.custom<string | undefined>((_tui, _theme, _keybindings, done) => {
			dismiss = () => done(undefined);
			const input = new SecretInput({ prompt: "Linear API key: ", placeholder: "lin_api_..." });
			input.onSubmit = (value) => done(value);
			input.onEscape = () => done(undefined);
			return input;
		});
	} finally {
		ctx.signal?.removeEventListener("abort", onAbort);
		dismiss = undefined;
	}
}

const readGuidelines = [
	"Use linear_list_teams before creating an issue when the team ID is unknown.",
	"Use linear_list_labels before assigning labels when a label ID is unknown.",
	"Use linear_get_issue for a known issue identifier such as ENG-123.",
	"Use linear_list_issues with a team key or search query to find matching issues.",
	"Use linear_list_issue_relations to page through an issue's blocking or blocked-by relations.",
	"Issue update labelIds replaces the complete label set; omit it to leave labels unchanged.",
];

export default function linearExtension(pi: ExtensionAPI): void {
	pi.registerCommand("linear-login", {
		description: "Open Linear Security & Access and save an API key in macOS Keychain",
		handler: async (_args, ctx) => {
			if (process.platform !== "darwin") {
				ctx.ui.notify("/linear-login currently requires macOS Keychain; set LINEAR_API_KEY manually on this platform", "error");
				return;
			}

			try {
				const opened = await pi.exec(
					"/usr/bin/open",
					[LINEAR_SECURITY_URL],
					{ timeout: 10_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
				);
				if (opened.code !== 0) ctx.ui.notify(`Open Linear manually: ${LINEAR_SECURITY_URL}`, "warning");
			} catch {
				ctx.ui.notify(`Open Linear manually: ${LINEAR_SECURITY_URL}`, "warning");
			}

			const entered = await promptApiKey(ctx);
			if (!entered) {
				ctx.ui.notify("Linear login cancelled", "info");
				return;
			}
			const apiKey = entered.trim();
			if (!/^lin_api_[^\s]+$/u.test(apiKey)) {
				ctx.ui.notify("That does not look like a Linear personal API key (expected lin_api_...)", "error");
				return;
			}

			try {
				await saveKeychainApiKey(apiKey, ctx.signal);
				process.env.LINEAR_API_KEY = apiKey;
				ctx.ui.notify("Linear API key saved to macOS Keychain", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Could not save Linear API key", "error");
			}
		},
	});

	pi.registerTool({
		name: "linear_list_teams",
		label: "Linear List Teams",
		description: "List teams available to the authenticated Linear account." + OUTPUT_LIMITS,
		promptSnippet: "List Linear teams",
		promptGuidelines: readGuidelines,
		parameters: Type.Object({ limit: LIMIT, after: CURSOR }),
		async execute(_toolCallId, params, signal) {
			const teams = await listTeams(params.limit ?? 20, optional(params.after), signal);
			return result("list_teams", teams);
		},
	});

	pi.registerTool({
		name: "linear_list_labels",
		label: "Linear List Labels",
		description: "List issue labels, optionally filtered by team key or UUID." + OUTPUT_LIMITS,
		promptSnippet: "List Linear issue labels",
		promptGuidelines: readGuidelines,
		parameters: Type.Object({
			team: Type.Optional(Type.String({ description: "Team key such as ENG, or a team UUID" })),
			limit: LIMIT,
			after: CURSOR,
		}),
		async execute(_toolCallId, params, signal) {
			const labels = await listIssueLabels(params.limit ?? 20, optional(params.team), optional(params.after), signal);
			return result("list_labels", labels);
		},
	});

	pi.registerTool({
		name: "linear_list_issues",
		label: "Linear List Issues",
		description: "List or search Linear issues, ordered by most recently updated. Search matches issue titles or descriptions." + OUTPUT_LIMITS,
		promptSnippet: "List or search Linear issues",
		promptGuidelines: readGuidelines,
		parameters: Type.Object({
			team: Type.Optional(Type.String({ description: "Team key such as ENG, or a team UUID" })),
			query: Type.Optional(Type.String({ description: "Text to find in issue titles or descriptions" })),
			limit: LIMIT,
			after: CURSOR,
		}),
		async execute(_toolCallId, params, signal) {
			const issues = await listIssues(
				params.limit ?? 20,
				optional(params.team),
				optional(params.query),
				optional(params.after),
				signal,
			);
			return result("list_issues", issues);
		},
	});

	pi.registerTool({
		name: "linear_list_issue_relations",
		label: "Linear List Issue Relations",
		description: "List an issue's outgoing or incoming relations with pagination. Use this to retrieve relation IDs beyond the first 50 shown in issue results." + OUTPUT_LIMITS,
		promptSnippet: "List Linear issue dependencies",
		promptGuidelines: readGuidelines,
		parameters: Type.Object({
			issueId: Type.String({ description: "Linear issue UUID or identifier, such as ENG-123" }),
			direction: Type.Union([
				Type.Literal("blocks"),
				Type.Literal("blocked_by"),
			], { description: "Return outgoing relations (blocks) or incoming relations (blocked_by)" }),
			limit: LIMIT,
			after: CURSOR,
		}),
		async execute(_toolCallId, params, signal) {
			const relations = await listIssueRelations(
				required(params.issueId, "issueId"),
				params.direction,
				params.limit ?? 20,
				optional(params.after),
				signal,
			);
			return result("list_issue_relations", relations);
		},
	});

	pi.registerTool({
		name: "linear_get_issue",
		label: "Linear Get Issue",
		description: "Fetch one Linear issue by UUID or identifier such as ENG-123." + OUTPUT_LIMITS,
		promptSnippet: "Fetch a Linear issue",
		promptGuidelines: readGuidelines,
		parameters: Type.Object({ issueId: Type.String({ description: "Linear issue UUID or identifier, such as ENG-123" }) }),
		async execute(_toolCallId, params, signal) {
			const issue = await getIssue(required(params.issueId, "issueId"), signal);
			return result("get_issue", issue);
		},
	});

	pi.registerTool({
		name: "linear_create_issue",
		label: "Linear Create Issue",
		description: "Create a Linear issue. Requires a team UUID and title. labelIds replaces the issue's labels and parentId assigns a parent issue." + OUTPUT_LIMITS,
		promptSnippet: "Create a Linear issue",
		executionMode: "sequential",
		parameters: Type.Object({
			teamId: Type.String({ description: "Linear team UUID; get it with linear_list_teams" }),
			title: Type.String({ description: "Issue title" }),
			description: Type.Optional(Type.String({ description: "Issue description in Markdown" })),
			stateId: Type.Optional(Type.String({ description: "Workflow state UUID" })),
			assigneeId: Type.Optional(Type.String({ description: "Assignee user UUID" })),
			labelIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Complete replacement label UUID list; get IDs with linear_list_labels" })),
			parentId: Type.Optional(Type.String({ description: "Parent issue UUID or identifier" })),
		}),
		async execute(_toolCallId, params, signal) {
			const teamId = required(params.teamId, "teamId");
			const title = required(params.title, "title");
			const description = params.description;
			const stateId = optional(params.stateId);
			const assigneeId = optional(params.assigneeId);
			const labelIds = optionalIds(params.labelIds, "labelIds");
			const parentId = optional(params.parentId);
			const issue = await createIssue({
				teamId,
				title,
				...(description !== undefined ? { description } : {}),
				...(stateId ? { stateId } : {}),
				...(assigneeId ? { assigneeId } : {}),
				...(labelIds !== undefined ? { labelIds } : {}),
				...(parentId ? { parentId: await resolveIssueId(parentId, signal) } : {}),
			}, signal);
			return result("create_issue", issue);
		},
	});

	pi.registerTool({
		name: "linear_update_issue",
		label: "Linear Update Issue",
		description: "Update selected fields on a Linear issue. labelIds replaces the complete label set and parentId assigns a parent issue." + OUTPUT_LIMITS,
		promptSnippet: "Update a Linear issue",
		executionMode: "sequential",
		parameters: Type.Object({
			issueId: Type.String({ description: "Linear issue UUID or identifier, such as ENG-123" }),
			title: Type.Optional(Type.String({ description: "New issue title" })),
			description: Type.Optional(Type.String({ description: "New issue description in Markdown" })),
			stateId: Type.Optional(Type.String({ description: "New workflow state UUID" })),
			assigneeId: Type.Optional(Type.String({ description: "New assignee user UUID" })),
			labelIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Complete replacement label UUID list; use [] to clear labels" })),
			parentId: Type.Optional(Type.Union([
				Type.String({ description: "New parent issue UUID or identifier" }),
				Type.Null(),
			], { description: "New parent issue UUID or identifier; null removes the current parent" })),
		}),
		async execute(_toolCallId, params, signal) {
			const issueId = required(params.issueId, "issueId");
			const title = params.title === undefined ? undefined : required(params.title, "title");
			const description = params.description;
			const stateId = optional(params.stateId);
			const assigneeId = optional(params.assigneeId);
			const labelIds = optionalIds(params.labelIds, "labelIds");
			const parentId = params.parentId === null ? null : optional(params.parentId);
			if (title === undefined && description === undefined && stateId === undefined && assigneeId === undefined && labelIds === undefined && parentId === undefined) {
				throw new Error("Provide at least one field to update");
			}
			const issue = await updateIssue(
				issueId,
				{
					...(title === undefined ? {} : { title }),
					...(description === undefined ? {} : { description }),
					...(stateId === undefined ? {} : { stateId }),
					...(assigneeId === undefined ? {} : { assigneeId }),
					...(labelIds === undefined ? {} : { labelIds }),
					...(parentId === undefined ? {} : { parentId: parentId === null ? null : await resolveIssueId(parentId, signal) }),
				},
				signal,
			);
			return result("update_issue", issue);
		},
	});

	pi.registerTool({
		name: "linear_add_issue_relation",
		label: "Linear Add Issue Relation",
		description: "Create a native Linear dependency relation between two issues. Use blocks when issueId blocks relatedIssueId, or blocked_by for the reverse." + OUTPUT_LIMITS,
		promptSnippet: "Add a Linear blocking dependency",
		executionMode: "sequential",
		parameters: Type.Object({
			issueId: Type.String({ description: "Linear issue UUID or identifier, such as ENG-123" }),
			relatedIssueId: Type.String({ description: "Other issue UUID or identifier, such as ENG-124" }),
			relation: Type.Union([
				Type.Literal("blocks"),
				Type.Literal("blocked_by"),
			], { description: "Whether issueId blocks or is blocked by relatedIssueId" }),
		}),
		async execute(_toolCallId, params, signal) {
			const issueId = required(params.issueId, "issueId");
			const relatedIssueId = required(params.relatedIssueId, "relatedIssueId");
			const resolvedIssueId = await resolveIssueId(issueId, signal);
			const resolvedRelatedIssueId = await resolveIssueId(relatedIssueId, signal);
			if (resolvedIssueId === resolvedRelatedIssueId) throw new Error("An issue cannot relate to itself");
			const relation = await createIssueRelation({
				issueId: resolvedIssueId,
				relatedIssueId: resolvedRelatedIssueId,
				relation: params.relation,
			}, signal);
			return result("add_issue_relation", relation);
		},
	});

	pi.registerTool({
		name: "linear_remove_issue_relation",
		label: "Linear Remove Issue Relation",
		description: "Remove a native Linear issue relation by its relation UUID. Relation IDs are returned by linear_list_issue_relations, linear_get_issue, and linear_list_issues." + OUTPUT_LIMITS,
		promptSnippet: "Remove a Linear blocking dependency",
		executionMode: "sequential",
		parameters: Type.Object({
			relationId: Type.String({ description: "Issue relation UUID returned in an issue's relations or inverseRelations" }),
		}),
		async execute(_toolCallId, params, signal) {
			const relationId = required(params.relationId, "relationId");
			const relation = await deleteIssueRelation(relationId, signal);
			return result("remove_issue_relation", relation);
		},
	});

	pi.registerTool({
		name: "linear_add_comment",
		label: "Linear Add Comment",
		description: "Add a Markdown comment to a Linear issue." + OUTPUT_LIMITS,
		promptSnippet: "Comment on a Linear issue",
		executionMode: "sequential",
		parameters: Type.Object({
			issueId: Type.String({ description: "Linear issue UUID or identifier, such as ENG-123" }),
			body: Type.String({ description: "Comment body in Markdown" }),
		}),
		async execute(_toolCallId, params, signal) {
			const issueId = required(params.issueId, "issueId");
			const body = required(params.body, "body");
			const comment = await addComment(issueId, body, signal);
			return result("add_comment", comment);
		},
	});
}
