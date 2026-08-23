import { describe, expect, it } from 'vitest'
import { groupsReferencedByOutliner } from '../formats/blueprint/outlinerGroups'

describe('groupsReferencedByOutliner', () => {
	it('collects nested children and legacy content entries while ignoring UUID strings', () => {
		const groups = [
			{ uuid: 'root' },
			{ uuid: 'child' },
			{ uuid: 'legacy' },
			{ uuid: 'string-entry' },
			{ uuid: 'orphan' },
		]

		const referenced = groupsReferencedByOutliner(groups, [
			{
				uuid: 'root',
				children: [{ uuid: 'child', content: [{ uuid: 'legacy' }, 'string-entry'] }],
			},
			'string-entry',
		])

		expect(referenced.map(group => group.uuid)).toEqual(['root', 'child', 'legacy'])
	})

	it('keeps all groups when outliner is undefined', () => {
		const groups = [{ uuid: 'first' }, { uuid: 'second' }]

		expect(groupsReferencedByOutliner(groups, undefined)).toEqual(groups)
	})

	it('excludes all groups for a defined empty outliner', () => {
		const groups = [{ uuid: 'orphan' }]

		expect(groupsReferencedByOutliner(groups, [])).toEqual([])
	})
})
