import { beforeEach, describe, expect, it, vi } from 'vitest'

let targetVersion = '1.20.4'

vi.mock('../formats/blueprint', () => ({
	projectTargetVersionIsAtLeast(version: string) {
		const actual = targetVersion.split('.').map(Number)
		const expected = version.split('.').map(Number)
		for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
			const actualPart = actual[index] ?? 0
			const expectedPart = expected[index] ?? 0
			if (actualPart !== expectedPart) return actualPart > expectedPart
		}
		return true
	},
}))

import { isCubeValid } from '../systems/util'

function cubeWithRotation(rotation: [number, number, number]) {
	return { rotation } as Cube
}

describe('Cube rotation validity', () => {
	beforeEach(() => {
		targetVersion = '1.20.4'
	})

	it('rejects multi-axis rotations even when their values cancel out', () => {
		expect(isCubeValid(cubeWithRotation([45, -45, 0]))).toBe('invalid')
		expect(isCubeValid(cubeWithRotation([22.5, 0, -22.5]))).toBe('invalid')
	})

	it('keeps the pre-1.21.6 single-axis step rules', () => {
		expect(isCubeValid(cubeWithRotation([0, 0, 0]))).toBe('valid')
		expect(isCubeValid(cubeWithRotation([22.5, 0, 0]))).toBe('valid')
		expect(isCubeValid(cubeWithRotation([10, 0, 0]))).toBe('invalid')
	})

	it('allows arbitrary single-axis angles within the 1.21.6 range', () => {
		targetVersion = '1.21.6'

		expect(isCubeValid(cubeWithRotation([10, 0, 0]))).toBe('1.21.6+')
		expect(isCubeValid(cubeWithRotation([0, -45, 0]))).toBe('1.21.6+')
		expect(isCubeValid(cubeWithRotation([0, 0, 45.1]))).toBe('invalid')
		expect(isCubeValid(cubeWithRotation([10, 10, 0]))).toBe('invalid')
	})

	it('keeps unrestricted rotations valid on 1.21.11 and later', () => {
		targetVersion = '1.21.11'

		expect(isCubeValid(cubeWithRotation([90, -60, 30]))).toBe('valid')
	})
})
