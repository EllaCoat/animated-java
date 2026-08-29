import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CUBE_MOD_SOURCE = readFileSync(new URL('../mods/cube.ts', import.meta.url), 'utf8')

describe('cube rotation outline contract', () => {
	it('keeps the red invalid-rotation outline without showing a toast', () => {
		expect(CUBE_MOD_SOURCE).not.toContain('Blockbench.showToastNotification')
		expect(CUBE_MOD_SOURCE).not.toContain('showToastNotification')
		expect(CUBE_MOD_SOURCE).toContain("ERROR_OUTLINE_MATERIAL.color.set('#ff0000')")
		expect(CUBE_MOD_SOURCE).toContain('updateCubeValidity(cube, false)')
	})
})
