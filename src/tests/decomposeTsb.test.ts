/**
 * decomposeTsb ヘッドレス単体テスト。 plain number[] で動くため THREE polyfill 不要。
 *
 * 確認するのは :
 * 1. identity / pure rotation / uniform scale / non-uniform scale / shear matrix の SVD 往復一致
 * 2. scale_class が正しく identity / uniform / non-uniform に分類されること
 * 3. ε = 10^(-digits) の境界挙動
 */
import { describe, expect, it } from 'vitest'
import { decomposeTsb, type DecomposedTsb } from '../systems/datapackCompiler/decomposeTsb'

// --- helpers ----------------------------------------------------------------

/** THREE.Matrix4 と同じ column-major レイアウトで 4×4 単位行列を作る。 */
function identity16(): number[] {
	return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/**
 * 4×4 column-major matrix を `T · R_left · S · R_right` 形式で組み立てる
 * (= MC の transformation NBT と同じ構造)。 SVD 結果から逆方向に matrix を再構成して
 * 元と一致するかを確認するためのヘルパー。
 */
function composeFromTRS(
	t: readonly [number, number, number],
	rl: readonly [number, number, number, number],
	s: readonly [number, number, number],
	rr: readonly [number, number, number, number]
): number[] {
	const Rl = matFromQuat(rl)
	const Rr = matFromQuat(rr)
	const S: number[][] = [
		[s[0], 0, 0],
		[0, s[1], 0],
		[0, 0, s[2]],
	]
	// R_left · S · R_right
	const RlS = matMul3(Rl, S)
	const M = matMul3(RlS, Rr)
	// column-major 4×4 に埋める
	return [
		M[0][0], M[1][0], M[2][0], 0,
		M[0][1], M[1][1], M[2][1], 0,
		M[0][2], M[1][2], M[2][2], 0,
		t[0], t[1], t[2], 1,
	]
}

/** unit quaternion (x, y, z, w) → 3×3 回転行列 (row major)。 */
function matFromQuat(q: readonly [number, number, number, number]): number[][] {
	const [x, y, z, w] = q
	const xx = x * x
	const yy = y * y
	const zz = z * z
	const xy = x * y
	const xz = x * z
	const yz = y * z
	const wx = w * x
	const wy = w * y
	const wz = w * z
	return [
		[1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
		[2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
		[2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
	]
}

function matMul3(A: readonly number[][], B: readonly number[][]): number[][] {
	const R: number[][] = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	]
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++) R[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]
	return R
}

/** decomposed を `T · R_left · S · R_right` で再構成 → 元の matrix と要素ごとに近いか確認。 */
function expectRoundTrip(original: readonly number[], decomposed: DecomposedTsb, tol = 1e-9) {
	const reconstructed = composeFromTRS(
		decomposed.translation,
		decomposed.left_rotation,
		decomposed.scale,
		decomposed.right_rotation
	)
	for (let i = 0; i < 16; i++) {
		expect(reconstructed[i]).toBeCloseTo(original[i], -Math.log10(tol))
	}
}

const OPTS = { quantizationDigits: 5 } // ε = 1e-5

// --- tests ------------------------------------------------------------------

describe('decomposeTsb - identity matrix', () => {
	it('returns identity TRS + scale_class = identity', () => {
		const r = decomposeTsb(identity16(), OPTS)
		expect(r.scale_class).toBe('identity')
		expect(r.translation).toEqual([0, 0, 0])
		expect(r.scale[0]).toBeCloseTo(1, 9)
		expect(r.scale[1]).toBeCloseTo(1, 9)
		expect(r.scale[2]).toBeCloseTo(1, 9)
		expectRoundTrip(identity16(), r)
	})
})

describe('decomposeTsb - pure translation', () => {
	it('extracts translation, scale_class = identity', () => {
		const m = identity16()
		m[12] = 1.5
		m[13] = -2.25
		m[14] = 0.5
		const r = decomposeTsb(m, OPTS)
		expect(r.translation).toEqual([1.5, -2.25, 0.5])
		expect(r.scale_class).toBe('identity')
		expectRoundTrip(m, r)
	})
})

describe('decomposeTsb - pure Z-axis 90deg rotation', () => {
	it('extracts left_rotation, scale_class = identity', () => {
		// THREE.Matrix4 column-major で Z 軸 90° 回転 :
		// basis x = (0, 1, 0), basis y = (-1, 0, 0), basis z = (0, 0, 1)
		const m: number[] = [
			0, 1, 0, 0,
			-1, 0, 0, 0,
			0, 0, 1, 0,
			0, 0, 0, 1,
		]
		const r = decomposeTsb(m, OPTS)
		expect(r.scale_class).toBe('identity')
		expectRoundTrip(m, r)
		// left_rotation の z 成分 / w 成分が ±sin(45°) / ±cos(45°) のはず (符号は SVD の自由度)
		const sin45 = Math.SQRT1_2
		const [, , qz, qw] = r.left_rotation
		expect(Math.abs(qz)).toBeCloseTo(sin45, 6)
		expect(Math.abs(qw)).toBeCloseTo(sin45, 6)
	})
})

describe('decomposeTsb - uniform scale', () => {
	it('classifies as uniform when sx ≒ sy ≒ sz ≠ 1', () => {
		const m = identity16()
		m[0] = 2
		m[5] = 2
		m[10] = 2
		const r = decomposeTsb(m, OPTS)
		expect(r.scale_class).toBe('uniform')
		expect(r.scale[0]).toBeCloseTo(2, 9)
		expect(r.scale[1]).toBeCloseTo(2, 9)
		expect(r.scale[2]).toBeCloseTo(2, 9)
		expectRoundTrip(m, r)
	})
})

describe('decomposeTsb - non-uniform scale (no shear)', () => {
	it('classifies as non-uniform and round-trips', () => {
		const m = identity16()
		m[0] = 2
		m[5] = 3
		m[10] = 4
		const r = decomposeTsb(m, OPTS)
		expect(r.scale_class).toBe('non-uniform')
		expectRoundTrip(m, r)
	})
})

describe('decomposeTsb - shear matrix', () => {
	it('decomposes a shear and round-trips through T·R₁·S·R₂', () => {
		// shear matrix (XY shear) : column-major で
		//   [[1, 1, 0],
		//    [0, 1, 0],
		//    [0, 0, 1]]
		// elements[col*4+row] で埋める
		const m = identity16()
		m[4] = 1 // M[0][1] = 1 (XY shear)
		const r = decomposeTsb(m, OPTS)
		expect(r.scale_class).toBe('non-uniform')
		expectRoundTrip(m, r, 1e-8)
	})
})

describe('decomposeTsb - composed non-uniform parent × child rotation', () => {
	it('decomposes the shear arising from S_parent · R_child and round-trips', () => {
		// 親 scale = diag(2, 1, 1)、 子 = Z 軸 45° 回転
		const Sp: number[][] = [
			[2, 0, 0],
			[0, 1, 0],
			[0, 0, 1],
		]
		const cos45 = Math.SQRT1_2
		const sin45 = Math.SQRT1_2
		const Rc: number[][] = [
			[cos45, -sin45, 0],
			[sin45, cos45, 0],
			[0, 0, 1],
		]
		const SR = matMul3(Sp, Rc)
		const m: number[] = [
			SR[0][0], SR[1][0], SR[2][0], 0,
			SR[0][1], SR[1][1], SR[2][1], 0,
			SR[0][2], SR[1][2], SR[2][2], 0,
			0, 0, 0, 1,
		]
		const r = decomposeTsb(m, OPTS)
		expect(r.scale_class).toBe('non-uniform')
		expectRoundTrip(m, r, 1e-8)
	})
})

describe('decomposeTsb - epsilon connected to quantization digits', () => {
	it('classifies scale (1.0001, 1, 1) as identity when digits=2 (ε=0.01)', () => {
		const m = identity16()
		m[0] = 1.0001
		const r = decomposeTsb(m, { quantizationDigits: 2 })
		expect(r.scale_class).toBe('identity')
	})
	it('classifies scale (1.0001, 1, 1) as non-uniform when digits=5 (ε=1e-5)', () => {
		const m = identity16()
		m[0] = 1.0001
		const r = decomposeTsb(m, { quantizationDigits: 5 })
		expect(r.scale_class).toBe('non-uniform')
	})
	it('classifies scale (2, 2.000001, 2) as uniform when digits=5 (ε=1e-5)', () => {
		const m = identity16()
		m[0] = 2
		m[5] = 2.000001
		m[10] = 2
		const r = decomposeTsb(m, { quantizationDigits: 5 })
		expect(r.scale_class).toBe('uniform')
	})
})
