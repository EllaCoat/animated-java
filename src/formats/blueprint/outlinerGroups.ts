interface GroupWithUUID {
	uuid?: unknown
}

interface OutlinerGroupEntry {
	uuid?: unknown
	children?: unknown
	content?: unknown
}

export function groupsReferencedByOutliner<T extends GroupWithUUID>(
	groups: readonly T[],
	outliner: readonly unknown[] | undefined
): T[] {
	if (outliner === undefined) return [...groups]

	const referencedUUIDs = new Set<string>()
	function visit(entries: readonly unknown[]) {
		for (const entry of entries) {
			if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue

			const group = entry as OutlinerGroupEntry
			if (typeof group.uuid === 'string') referencedUUIDs.add(group.uuid)
			if (Array.isArray(group.children)) visit(group.children)
			if (Array.isArray(group.content)) visit(group.content)
		}
	}

	visit(outliner)
	return groups.filter(group => typeof group.uuid === 'string' && referencedUUIDs.has(group.uuid))
}
