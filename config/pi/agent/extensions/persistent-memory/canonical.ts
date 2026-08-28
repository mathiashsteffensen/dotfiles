import { createHash } from "node:crypto";

export function codePointLength(value: string): number {
	return Array.from(value).length;
}

export function utf8Length(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function isUnicodeScalarString(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

function assertUnicodeScalarString(value: string): void {
	if (!isUnicodeScalarString(value)) {
		throw new TypeError("canonical JSON rejects lone Unicode surrogates");
	}
}

/** RFC 8785 canonical JSON for the JSON-only values used by this extension. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "string") {
		assertUnicodeScalarString(value);
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires a finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (typeof value === "object") {
		const object = value as Record<string, unknown>;
		const keys = Object.keys(object).sort();
		return `{${keys
			.map((key) => {
				assertUnicodeScalarString(key);
				const item = object[key];
				if (item === undefined) throw new TypeError("canonical JSON does not allow undefined");
				return `${JSON.stringify(key)}:${canonicalJson(item)}`;
			})
			.join(",")}}`;
	}
	throw new TypeError("canonical JSON only supports JSON values");
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashCanonicalJson(value: unknown): string {
	return sha256Hex(canonicalJson(value));
}

export function deepFreeze<T>(value: T): Readonly<T> {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child);
		}
		Object.freeze(value);
	}
	return value;
}
