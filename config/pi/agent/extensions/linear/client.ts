import { spawn } from "node:child_process";

export const LINEAR_API_URL = "https://api.linear.app/graphql";
export const LINEAR_SECURITY_URL = "https://linear.app/settings/account/security";
export const LINEAR_KEYCHAIN_SERVICE = "pi-linear-api-key";
export const LINEAR_KEYCHAIN_ACCOUNT = "linear-api-key";

const REQUEST_TIMEOUT_MS = 30_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;

type JsonObject = Record<string, unknown>;

export interface LinearPageInfo {
	hasNextPage: boolean;
	endCursor: string | null;
}

export interface LinearConnection<T> {
	nodes: T[];
	pageInfo: LinearPageInfo;
}

export interface LinearTeam {
	id: string;
	key: string;
	name: string;
}

export interface LinearIssueLabel {
	id: string;
	name: string;
	color: string;
	description: string | null;
	team: Pick<LinearTeam, "id" | "key" | "name"> | null;
}

export interface LinearIssueRelation {
	id: string;
	type: "blocks" | string;
	issue: { id: string; identifier: string; title: string };
	relatedIssue: { id: string; identifier: string; title: string };
}

export type IssueRelationDirection = "blocks" | "blocked_by";

export interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	url: string;
	createdAt: string;
	updatedAt: string;
	team: Pick<LinearTeam, "id" | "key" | "name">;
	state: { id: string; name: string; type: string } | null;
	assignee: { id: string; name: string } | null;
	project: { id: string; name: string } | null;
	parent: { id: string; identifier: string; title: string } | null;
	labels: LinearConnection<Pick<LinearIssueLabel, "id" | "name" | "color">>;
	relations: LinearConnection<LinearIssueRelation>;
	inverseRelations: LinearConnection<LinearIssueRelation>;
}

export interface CreateIssueInput {
	teamId: string;
	title: string;
	description?: string;
	stateId?: string;
	assigneeId?: string;
	labelIds?: string[];
	parentId?: string;
}

export interface UpdateIssueInput {
	title?: string;
	description?: string;
	stateId?: string;
	assigneeId?: string;
	labelIds?: string[];
	parentId?: string | null;
}

export interface CreateIssueRelationInput {
	issueId: string;
	relatedIssueId: string;
	relation: IssueRelationDirection;
}

interface GraphQLError {
	message?: unknown;
}

interface GraphQLResponse<T> {
	data?: T;
	errors?: GraphQLError[];
}

const ISSUE_FIELDS = `
	id
	identifier
	title
	description
	url
	createdAt
	updatedAt
	team { id key name }
	state { id name type }
	assignee { id name }
	project { id name }
	parent { id identifier title }
	labels {
		nodes { id name color }
		pageInfo { hasNextPage endCursor }
	}
	relations(first: 50) {
		nodes { id type issue { id identifier title } relatedIssue { id identifier title } }
		pageInfo { hasNextPage endCursor }
	}
	inverseRelations(first: 50) {
		nodes { id type issue { id identifier title } relatedIssue { id identifier title } }
		pageInfo { hasNextPage endCursor }
	}
`;

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shorten(value: string, maxLength = 1_000): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

export function formatGraphQLErrors(errors: readonly GraphQLError[]): string {
	return errors
		.map((error) => (typeof error.message === "string" ? error.message : "Unknown GraphQL error"))
		.join("; ");
}

export function buildIssueFilter(team?: string, query?: string): JsonObject | undefined {
	const filters: JsonObject[] = [];
	const teamValue = team?.trim();
	const queryValue = query?.trim();

	if (teamValue) {
		filters.push({
			team: {
				or: [
					{ id: { eq: teamValue } },
					{ key: { eqIgnoreCase: teamValue } },
				],
			},
		});
	}

	if (queryValue) {
		filters.push({
			or: [
				{ title: { containsIgnoreCase: queryValue } },
				{ description: { containsIgnoreCase: queryValue } },
			],
		});
	}

	if (filters.length === 0) return undefined;
	if (filters.length === 1) return filters[0];
	return { and: filters };
}

export function buildIssueLabelFilter(team?: string): JsonObject | undefined {
	const teamValue = team?.trim();
	if (!teamValue) return undefined;
	return {
		team: {
			or: [
				{ id: { eq: teamValue } },
				{ key: { eqIgnoreCase: teamValue } },
			],
		},
	};
}

export function normalizeIssueRelation(
	issueId: string,
	relatedIssueId: string,
	relation: IssueRelationDirection,
): { issueId: string; relatedIssueId: string; type: "blocks" } {
	return relation === "blocks"
		? { issueId, relatedIssueId, type: "blocks" }
		: { issueId: relatedIssueId, relatedIssueId: issueId, type: "blocks" };
}

function runSecurityCommand(command: string, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => {
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.once("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `security exited with code ${code ?? "unknown"}`));
		});
		child.stdin.end(`${command}\n`);
	});
}

function keychainArgument(value: string): string {
	if (value.includes("\n") || value.includes("\r")) throw new Error("Linear API key must be a single line");
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export async function saveKeychainApiKey(apiKey: string, signal?: AbortSignal): Promise<void> {
	if (process.platform !== "darwin") throw new Error("macOS Keychain is only available on macOS");
	const encodedApiKey = Buffer.from(apiKey, "utf8").toString("hex");
	await runSecurityCommand(
		`add-generic-password -U -a ${keychainArgument(LINEAR_KEYCHAIN_ACCOUNT)} -s ${keychainArgument(LINEAR_KEYCHAIN_SERVICE)} -X ${encodedApiKey}`,
		signal,
	);
}

async function readKeychainApiKey(signal?: AbortSignal): Promise<string | undefined> {
	if (process.platform !== "darwin") return undefined;
	return new Promise((resolve, reject) => {
		const child = spawn(
			"/usr/bin/security",
			["find-generic-password", "-a", LINEAR_KEYCHAIN_ACCOUNT, "-s", LINEAR_KEYCHAIN_SERVICE, "-w"],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		let stdout = "";
		const timeout = setTimeout(() => child.kill("SIGTERM"), KEYCHAIN_TIMEOUT_MS);
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			if (code === 0) resolve(stdout.trim() || undefined);
			else resolve(undefined);
		});
	});
}

async function resolveApiKey(signal?: AbortSignal): Promise<string | undefined> {
	const environmentKey = process.env.LINEAR_API_KEY?.trim();
	if (environmentKey) return environmentKey;
	return readKeychainApiKey(signal);
}

export async function linearRequest<T>(
	query: string,
	variables: JsonObject,
	signal?: AbortSignal,
): Promise<T> {
	const apiKey = await resolveApiKey(signal);
	if (!apiKey) {
		throw new Error("Linear API key is unavailable. Run /linear-login or set LINEAR_API_KEY.");
	}

	signal?.throwIfAborted();
	const requestSignal = signal
		? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
		: AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(LINEAR_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: apiKey,
		},
		body: JSON.stringify({ query, variables }),
		signal: requestSignal,
	});
	const body = await response.text();

	let payload: GraphQLResponse<T>;
	try {
		const parsed: unknown = JSON.parse(body);
		if (!isObject(parsed)) throw new Error("response is not an object");
		payload = parsed as GraphQLResponse<T>;
	} catch {
		throw new Error(`Linear API returned invalid JSON (HTTP ${response.status})`);
	}

	if (!response.ok) {
		throw new Error(`Linear API request failed (HTTP ${response.status}): ${shorten(body)}`);
	}
	if (payload.errors && payload.errors.length > 0) {
		throw new Error(`Linear GraphQL error: ${formatGraphQLErrors(payload.errors)}`);
	}
	if (!("data" in payload)) throw new Error("Linear API response did not include data");
	return payload.data as T;
}

export async function listTeams(
	first: number,
	after?: string,
	signal?: AbortSignal,
): Promise<LinearConnection<LinearTeam>> {
	const data = await linearRequest<{ teams: LinearConnection<LinearTeam> }>(
		`query Teams($first: Int!, $after: String) {
			teams(first: $first, after: $after) {
				nodes { id key name }
				pageInfo { hasNextPage endCursor }
			}
		}`,
		{ first, ...(after ? { after } : {}) },
		signal,
	);
	return data.teams;
}

export async function listIssueLabels(
	first: number,
	team?: string,
	after?: string,
	signal?: AbortSignal,
): Promise<LinearConnection<LinearIssueLabel>> {
	const filter = buildIssueLabelFilter(team);
	const data = await linearRequest<{ issueLabels: LinearConnection<LinearIssueLabel> }>(
		`query IssueLabels($filter: IssueLabelFilter, $first: Int!, $after: String) {
			issueLabels(filter: $filter, first: $first, after: $after) {
				nodes { id name color description team { id key name } }
				pageInfo { hasNextPage endCursor }
			}
		}`,
		{ first, ...(filter ? { filter } : {}), ...(after ? { after } : {}) },
		signal,
	);
	return data.issueLabels;
}

export async function listIssueRelations(
	issueId: string,
	direction: IssueRelationDirection,
	first: number,
	after?: string,
	signal?: AbortSignal,
): Promise<LinearConnection<LinearIssueRelation>> {
	const field = direction === "blocks" ? "relations" : "inverseRelations";
	const data = await linearRequest<{
		issue: { relationConnection: LinearConnection<LinearIssueRelation> } | null;
	}>(
		`query IssueRelations($id: String!, $first: Int!, $after: String) {
			issue(id: $id) {
				relationConnection: ${field}(first: $first, after: $after) {
					nodes { id type issue { id identifier title } relatedIssue { id identifier title } }
					pageInfo { hasNextPage endCursor }
				}
			}
		}`,
		{ id: issueId, first, ...(after ? { after } : {}) },
		signal,
	);
	if (!data.issue) throw new Error(`Linear issue not found: ${issueId}`);
	const relationConnection = data.issue.relationConnection;
	return {
		...relationConnection,
		nodes: relationConnection.nodes.filter((relation) => relation.type === "blocks"),
	};
}

export async function listIssues(
	first: number,
	team?: string,
	query?: string,
	after?: string,
	signal?: AbortSignal,
): Promise<LinearConnection<LinearIssue>> {
	const filter = buildIssueFilter(team, query);
	const data = await linearRequest<{ issues: LinearConnection<LinearIssue> }>(
		`query Issues($filter: IssueFilter, $first: Int!, $after: String) {
			issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
				nodes { ${ISSUE_FIELDS} }
				pageInfo { hasNextPage endCursor }
			}
		}`,
		{ first, ...(filter ? { filter } : {}), ...(after ? { after } : {}) },
		signal,
	);
	return data.issues;
}

export async function getIssue(id: string, signal?: AbortSignal): Promise<LinearIssue> {
	const data = await linearRequest<{ issue: LinearIssue | null }>(
		`query Issue($id: String!) {
			issue(id: $id) { ${ISSUE_FIELDS} }
		}`,
		{ id },
		signal,
	);
	if (!data.issue) throw new Error(`Linear issue not found: ${id}`);
	return data.issue;
}

export async function createIssue(
	input: CreateIssueInput,
	signal?: AbortSignal,
): Promise<LinearIssue> {
	const data = await linearRequest<{ issueCreate: { success: boolean; issue: LinearIssue | null } }>(
		`mutation IssueCreate($input: IssueCreateInput!) {
			issueCreate(input: $input) {
				success
				issue { ${ISSUE_FIELDS} }
			}
		}`,
		{ input },
		signal,
	);
	if (!data.issueCreate.success || !data.issueCreate.issue) {
		throw new Error("Linear did not create the issue");
	}
	return data.issueCreate.issue;
}

export async function updateIssue(
	id: string,
	input: UpdateIssueInput,
	signal?: AbortSignal,
): Promise<LinearIssue> {
	const data = await linearRequest<{ issueUpdate: { success: boolean; issue: LinearIssue | null } }>(
		`mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
			issueUpdate(id: $id, input: $input) {
				success
				issue { ${ISSUE_FIELDS} }
			}
		}`,
		{ id, input },
		signal,
	);
	if (!data.issueUpdate.success || !data.issueUpdate.issue) {
		throw new Error(`Linear did not update issue: ${id}`);
	}
	return data.issueUpdate.issue;
}

export async function createIssueRelation(
	input: CreateIssueRelationInput,
	signal?: AbortSignal,
): Promise<LinearIssueRelation> {
	const data = await linearRequest<{
		issueRelationCreate: { success: boolean; issueRelation: LinearIssueRelation | null };
	}>(
		`mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
			issueRelationCreate(input: $input) {
				success
				issueRelation { id type issue { id identifier title } relatedIssue { id identifier title } }
			}
		}`,
		{ input: normalizeIssueRelation(input.issueId, input.relatedIssueId, input.relation) },
		signal,
	);
	if (!data.issueRelationCreate.success || !data.issueRelationCreate.issueRelation) {
		throw new Error("Linear did not create the issue relation");
	}
	return data.issueRelationCreate.issueRelation;
}

async function getIssueRelation(
	relationId: string,
	signal?: AbortSignal,
): Promise<LinearIssueRelation | null> {
	const data = await linearRequest<{ issueRelation: LinearIssueRelation | null }>(
		`query IssueRelation($id: String!) {
			issueRelation(id: $id) { id type issue { id identifier title } relatedIssue { id identifier title } }
		}`,
		{ id: relationId },
		signal,
	);
	return data.issueRelation;
}

export async function deleteIssueRelation(
	relationId: string,
	signal?: AbortSignal,
): Promise<{ id: string }> {
	const relation = await getIssueRelation(relationId, signal);
	if (!relation) throw new Error(`Linear issue relation not found: ${relationId}`);
	if (relation.type !== "blocks") throw new Error(`Linear issue relation is not a blocking relation: ${relationId}`);

	const data = await linearRequest<{
		issueRelationDelete: { success: boolean; entityId: string | null };
	}>(
		`mutation IssueRelationDelete($id: String!) {
			issueRelationDelete(id: $id) {
				success
				entityId
			}
		}`,
		{ id: relationId },
		signal,
	);
	if (!data.issueRelationDelete.success) {
		throw new Error(`Linear did not delete issue relation: ${relationId}`);
	}
	return { id: data.issueRelationDelete.entityId ?? relationId };
}

export async function addComment(
	issueId: string,
	body: string,
	signal?: AbortSignal,
): Promise<{ id: string; body: string; url: string }> {
	const data = await linearRequest<{
		commentCreate: { success: boolean; comment: { id: string; body: string; url: string } | null };
	}>(
		`mutation CommentCreate($input: CommentCreateInput!) {
			commentCreate(input: $input) {
				success
				comment { id body url }
			}
		}`,
		{ input: { issueId, body } },
		signal,
	);
	if (!data.commentCreate.success || !data.commentCreate.comment) {
		throw new Error(`Linear did not add a comment to issue: ${issueId}`);
	}
	return data.commentCreate.comment;
}
