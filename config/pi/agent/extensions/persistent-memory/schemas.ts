import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const UUID_V7_PATTERN =
	"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const SHA256_PATTERN = "^[0-9a-f]{64}$";
export const TIMESTAMP_PATTERN =
	"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

const closed = { additionalProperties: false } as const;
const UuidV7Schema = Type.String({ pattern: UUID_V7_PATTERN });
const Sha256Schema = Type.String({ pattern: SHA256_PATTERN });
const TimestampSchema = Type.String({ pattern: TIMESTAMP_PATTERN });
const NullableStringSchema = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const NullableUuidSchema = Type.Union([UuidV7Schema, Type.Null()]);
const NullableSha256Schema = Type.Union([Sha256Schema, Type.Null()]);

export const MemoryKindSchema = StringEnum(
	["preference", "fact", "constraint", "workflow", "correction"] as const,
);
export const RecallModeSchema = StringEnum(["relevant", "always"] as const);
export const TagSchema = Type.String({ minLength: 1, maxLength: 32 });

export const ProvenanceSchema = Type.Object(
	{
		capture: StringEnum(["direct", "distilled"] as const),
		capturedAt: TimestampSchema,
		sessionId: NullableStringSchema,
		entryIds: Type.Array(Type.String({ minLength: 1 })),
		sourceDigest: NullableSha256Schema,
		proposalId: NullableUuidSchema,
		proposalHash: NullableSha256Schema,
	},
	closed,
);

export const MemoryRecordSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		id: UuidV7Schema,
		content: Type.String({ minLength: 1, maxLength: 500 }),
		kind: MemoryKindSchema,
		recall: RecallModeSchema,
		tags: Type.Array(TagSchema, { maxItems: 8 }),
		enabled: Type.Boolean(),
		createdAt: TimestampSchema,
		updatedAt: TimestampSchema,
		provenance: ProvenanceSchema,
		supersedes: Type.Array(UuidV7Schema),
		modelDisclosure: Type.Literal("allowed"),
	},
	closed,
);

export const CandidateSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, maxLength: 500 }),
		kind: MemoryKindSchema,
		recall: RecallModeSchema,
		tags: Type.Array(TagSchema, { maxItems: 8 }),
		supersedes: Type.Array(UuidV7Schema),
	},
	closed,
);

export const ModelCandidateSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, maxLength: 500 }),
		kind: MemoryKindSchema,
		recall: RecallModeSchema,
		tags: Type.Array(TagSchema, { maxItems: 8 }),
	},
	closed,
);

export const ModelOutputSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		candidates: Type.Array(ModelCandidateSchema, { maxItems: 8 }),
	},
	closed,
);

export const ProposalSourceSchema = Type.Object(
	{
		sessionId: Type.String({ minLength: 1 }),
		entryIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		sourceDigest: Sha256Schema,
	},
	closed,
);

export const ProposalGeneratorSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 1 }),
	},
	closed,
);

export const ProposalSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		proposalId: UuidV7Schema,
		revision: Type.Integer({ minimum: 1 }),
		source: ProposalSourceSchema,
		candidate: CandidateSchema,
		candidateHash: Sha256Schema,
		generator: ProposalGeneratorSchema,
		createdAt: TimestampSchema,
	},
	closed,
);

export const ProposalStatusSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		proposalId: UuidV7Schema,
		candidateHash: Sha256Schema,
		status: StringEnum(["approved", "rejected"] as const),
		memoryId: NullableUuidSchema,
		decidedAt: TimestampSchema,
	},
	closed,
);

export const MemorySearchParameters = Type.Object(
	{
		query: Type.String({ minLength: 1, maxLength: 500 }),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 6 })),
	},
	closed,
);

export const MemoryGetParameters = Type.Object(
	{
		id: Type.String({ minLength: 8, maxLength: 36 }),
	},
	closed,
);

export type MemoryKind = Static<typeof MemoryKindSchema>;
export type RecallMode = Static<typeof RecallModeSchema>;
export type Provenance = Static<typeof ProvenanceSchema>;
export type MemoryRecord = Static<typeof MemoryRecordSchema>;
export type MemoryCandidate = Static<typeof CandidateSchema>;
export type ModelCandidate = Static<typeof ModelCandidateSchema>;
export type ModelOutput = Static<typeof ModelOutputSchema>;
export type ProposalSource = Static<typeof ProposalSourceSchema>;
export type ProposalGenerator = Static<typeof ProposalGeneratorSchema>;
export type MemoryProposal = Static<typeof ProposalSchema>;
export type ProposalStatus = Static<typeof ProposalStatusSchema>;
