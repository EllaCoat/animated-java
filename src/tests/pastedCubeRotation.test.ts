import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
	rotationConstraintsAreSuspended,
	runWithRotationConstraintsSuspended,
} from '../formats/blueprint/rotationConstraintGuard'

const OUTLINER_PASTE_MOD_SOURCE = readFileSync(
	new URL('../mods/outlinerPasteMod.ts', import.meta.url),
	'utf8'
)
const BLUEPRINT_FORMAT_SOURCE = readFileSync(
	new URL('../formats/blueprint/index.ts', import.meta.url),
	'utf8'
)

describe('pasted Cube rotation preservation', () => {
	it('keeps pasted and existing multi-axis rotations while restoring the edit constraint', () => {
		const format = { rotation_limit: true }
		const cubes = [{ rotation: [22.5, 15, 0] }, { rotation: [-10, 0, 30] }]
		const originalRotations = cubes.map(cube => [...cube.rotation])
		const restoreConstraints = vi.fn(() => {
			format.rotation_limit = true
		})

		runWithRotationConstraintsSuspended(
			format,
			() => {
				expect(rotationConstraintsAreSuspended()).toBe(true)
				if (format.rotation_limit) {
					for (const cube of cubes) {
						const axis = cube.rotation.findIndex(rotation => rotation !== 0)
						const angle = cube.rotation[axis]
						cube.rotation.fill(0)
						cube.rotation[axis] = angle
					}
				}
			},
			restoreConstraints
		)

		expect(cubes.map(cube => cube.rotation)).toEqual(originalRotations)
		expect(format.rotation_limit).toBe(true)
		expect(rotationConstraintsAreSuspended()).toBe(false)
		expect(restoreConstraints).toHaveBeenCalledOnce()
	})

	it('keeps the constraint suspended when selection updates during paste', () => {
		const format = { rotation_limit: true }

		runWithRotationConstraintsSuspended(
			format,
			() => {
				format.rotation_limit = true
				if (rotationConstraintsAreSuspended()) format.rotation_limit = false
				expect(format.rotation_limit).toBe(false)
			},
			() => {
				format.rotation_limit = true
			}
		)
	})

	it('restores the constraint when Blockbench paste throws', () => {
		const format = { rotation_limit: true }
		const restoreConstraints = vi.fn()

		expect(() =>
			runWithRotationConstraintsSuspended(
				format,
				() => {
					throw new Error('paste failed')
				},
				restoreConstraints
			)
		).toThrow('paste failed')

		expect(format.rotation_limit).toBe(true)
		expect(rotationConstraintsAreSuspended()).toBe(false)
		expect(restoreConstraints).toHaveBeenCalledOnce()
	})

	it('connects the paste patch and selection-update guard to the shared suspension state', () => {
		expect(OUTLINER_PASTE_MOD_SOURCE).toContain('Clipbench.pasteOutliner = function')
		expect(OUTLINER_PASTE_MOD_SOURCE).toContain('runWithRotationConstraintsSuspended(')
		expect(BLUEPRINT_FORMAT_SOURCE).toContain('if (rotationConstraintsAreSuspended())')
	})
})
