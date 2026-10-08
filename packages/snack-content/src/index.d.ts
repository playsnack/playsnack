export type ContentData = { bank?: unknown; pools?: { songs?: unknown[]; idols?: unknown[]; singers?: unknown[] } };
export function contentFor(kind: string, theme: string, data: ContentData, random?: () => number): Record<string, unknown> | null;
export function parseContentUrl(url: string): { kind: string; theme: string } | null;
export function hangulInitials(w: string): string;
export function sample<T>(arr: T[], n: number, random?: () => number): T[];
