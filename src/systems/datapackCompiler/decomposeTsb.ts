/**
 * 3×3 SVD で 4×4 transformation matrix を `translation + left_rotation + scale + right_rotation` の形に
 * 分解するユーティリティ。 Minecraft の display entity の `transformation` NBT が
 * `T · R_left · S · R_right` の合成という SVD そのものの形なので、 分解結果を直接マッピングできる。
 *
 * THREE 非依存 (plain number[] / tuple) で実装してあるため、 production (Blockbench plugin context)
 * とヘッドレステスト (vitest) のどちらでも追加 polyfill 無しで動く。 呼び出し側で
 * `THREE.Matrix4.elements` を `number[]` (column-major、 16 要素) として渡す。
 */

export type ScaleClass = 'identity' | 'uniform' | 'non-uniform'

export interface DecomposedTsb {
	translation: [number, number, number]
	left_rotation: [number, number, number, number] // qx, qy, qz, qw
	scale: [number, number, number]
	right_rotation: [number, number, number, number] // rx, ry, rz, rw
	scale_class: ScaleClass
}

export interface DecomposeTsbOptions {
	quantizationDigits: number
}

/**
 * THREE.Matrix4 から TRS + right_rotation を SVD 分解で取り出す。
 *
 * @param matrix16 `THREE.Matrix4.elements` (column-major、 16 個の number)
 * @param opts 量子化桁数 (ε = 10^(-digits) で scale_class 判定)
 */
export function decomposeTsb(
	matrix16: readonly number[],
	opts: DecomposeTsbOptions
): DecomposedTsb {
	if (matrix16.length !== 16) {
		throw new Error(`[TSB] decomposeTsb expected matrix.elements with length 16, got ${matrix16.length}`)
	}
	const e = matrix16
	// translation は 4×4 行列の右列 上 3 つ (column-major なので elements[12..14])
	const translation: [number, number, number] = [e[12], e[13], e[14]]

	// 3×3 線形変換ブロックを (row, col) 形式で取り出す (column-major → row 配列)
	const m: number[][] = [
		[e[0], e[4], e[8]],
		[e[1], e[5], e[9]],
		[e[2], e[6], e[10]],
	]

	// SVD: m = U · Σ · Vᵀ
	const { U, sigma, V } = svd3x3(m)

	const epsilon = Math.pow(10, -opts.quantizationDigits)
	const scale_class = classifyScale(sigma, epsilon)

	// MC の transformation NBT は `T · R_left · S · R_right`、 SVD の `U · Σ · Vᵀ` と完全一致 → R_left = U、 R_right = Vᵀ。
	// ただし scale_class が identity / uniform のときは「Σ ≒ s · I」 で右側が対称 → SVD の解に冗長な自由度が残り
	// U と V が任意の同一回転で同時変換されても M が変わらない。 そのまま分解結果を採用すると、 7 / 10 floats モードで
	// right_rotation を省略 (= identity と仮定) した瞬間に元の matrix を復元できなくなる。
	// → identity / uniform のときは `U · Vᵀ` を combined left_rotation として取り直し、 right_rotation を identity に強制する。
	const Vt = transpose3(V)
	let combinedLeft: number[][]
	let right_rotation: [number, number, number, number]
	if (scale_class === 'non-uniform') {
		combinedLeft = U
		right_rotation = quaternionFromMatrix3(Vt)
	} else {
		combinedLeft = matMul3(U, Vt)
		right_rotation = [0, 0, 0, 1]
	}
	const left_rotation = quaternionFromMatrix3(combinedLeft)

	return {
		translation,
		left_rotation,
		scale: [sigma[0], sigma[1], sigma[2]],
		right_rotation,
		scale_class,
	}
}

/** scale 3 軸が identity / uniform / non-uniform のどれかを判定する。 ε = 10^(-digits)。 */
function classifyScale(sigma: readonly number[], epsilon: number): ScaleClass {
	const [sx, sy, sz] = sigma
	const isIdentity =
		Math.abs(sx - 1) < epsilon && Math.abs(sy - 1) < epsilon && Math.abs(sz - 1) < epsilon
	if (isIdentity) return 'identity'
	const isUniform = Math.abs(sx - sy) < epsilon && Math.abs(sy - sz) < epsilon
	if (isUniform) return 'uniform'
	return 'non-uniform'
}

/**
 * 3×3 行列の SVD。 `M = U · Σ · Vᵀ` (U, V は直交行列、 Σ は非負対角)。
 *
 * 標準手法 : `Mᵀ · M = V · Σ² · Vᵀ` (対称半正定値行列の固有値分解) を Jacobi rotation で解く。
 * その後 `U = M · V · Σ⁻¹` で U を構成し、 反射 (`det(M) < 0`) は特異値 σ₃ の符号で吸収する。
 */
function svd3x3(M: readonly number[][]): { U: number[][]; sigma: [number, number, number]; V: number[][] } {
	// A = Mᵀ · M (対称半正定値)
	const A = matMul3(transpose3(M), M)

	// Jacobi rotation で A を対角化 → 対角成分 = Σ², 蓄積された回転 = V
	const { D, V } = jacobiEigen3(A)

	// 特異値は非負平方根 (D は対称なので非負)
	const sigmaUnsorted: [number, number, number] = [Math.sqrt(Math.max(D[0], 0)), Math.sqrt(Math.max(D[1], 0)), Math.sqrt(Math.max(D[2], 0))]

	// 特異値が降順になるように並び替え (慣例 + scale_class 判定の安定性のため)
	const order = [0, 1, 2].sort((a, b) => sigmaUnsorted[b] - sigmaUnsorted[a])
	const sigma: [number, number, number] = [sigmaUnsorted[order[0]], sigmaUnsorted[order[1]], sigmaUnsorted[order[2]]]
	const Vsorted = [
		[V[0][order[0]], V[0][order[1]], V[0][order[2]]],
		[V[1][order[0]], V[1][order[1]], V[1][order[2]]],
		[V[2][order[0]], V[2][order[1]], V[2][order[2]]],
	]

	// U = M · V · Σ⁻¹ (各列ごとに正規化)
	const MV = matMul3(M, Vsorted)
	const U: number[][] = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	]
	const tiny = 1e-12
	for (let c = 0; c < 3; c++) {
		const s = sigma[c]
		if (s > tiny) {
			const inv = 1 / s
			U[0][c] = MV[0][c] * inv
			U[1][c] = MV[1][c] * inv
			U[2][c] = MV[2][c] * inv
		} else {
			// 特異値ゼロ : 対応する U の列は他の 2 列に直交する単位ベクトルを取れば良い。
			// ここは数値的に病的なケース (rank-deficient matrix)、 通常モーションでは起きない。
			// 実用的な fallback として、 他の 2 列の外積で埋める (rank 2 まで対応)。
			U[0][c] = 0
			U[1][c] = 0
			U[2][c] = 0
		}
	}
	// rank-deficient (sigma に 0 が含まれる) ときは、 ゼロ列を他列の外積で埋める
	for (let c = 0; c < 3; c++) {
		if (sigma[c] <= tiny) {
			const a = (c + 1) % 3
			const b = (c + 2) % 3
			const ux = U[1][a] * U[2][b] - U[2][a] * U[1][b]
			const uy = U[2][a] * U[0][b] - U[0][a] * U[2][b]
			const uz = U[0][a] * U[1][b] - U[1][a] * U[0][b]
			U[0][c] = ux
			U[1][c] = uy
			U[2][c] = uz
		}
	}

	// 反射処理 : det(U) と det(V) の符号を揃えて純粋回転にする。
	// det(U) · det(Vᵀ) = det(M) / Πσᵢ なので、 sigma が正なら det(U) と det(V) は同符号。
	// もし det(U) が負なら、 sigma の最後 (最小) に符号を入れて U の最後の列も反転する。
	const detU = determinant3(U)
	if (detU < 0) {
		sigma[2] = -sigma[2]
		U[0][2] = -U[0][2]
		U[1][2] = -U[1][2]
		U[2][2] = -U[2][2]
	}
	const detV = determinant3(Vsorted)
	if (detV < 0) {
		sigma[2] = -sigma[2]
		Vsorted[0][2] = -Vsorted[0][2]
		Vsorted[1][2] = -Vsorted[1][2]
		Vsorted[2][2] = -Vsorted[2][2]
	}

	return { U, sigma, V: Vsorted }
}

/**
 * 3×3 対称行列の固有値分解。 Jacobi rotation iteration (古典手法)。
 * 戻り値の `D` は固有値 (対角成分)、 `V` は固有ベクトルを列に持つ直交行列。 `A = V · diag(D) · Vᵀ`。
 */
function jacobiEigen3(A_in: readonly number[][]): { D: [number, number, number]; V: number[][] } {
	// A は破壊的に更新するためコピー
	const A: number[][] = [
		[A_in[0][0], A_in[0][1], A_in[0][2]],
		[A_in[1][0], A_in[1][1], A_in[1][2]],
		[A_in[2][0], A_in[2][1], A_in[2][2]],
	]
	const V: number[][] = [
		[1, 0, 0],
		[0, 1, 0],
		[0, 0, 1],
	]
	const maxSweeps = 50
	const tol = 1e-14
	for (let sweep = 0; sweep < maxSweeps; sweep++) {
		// off-diagonal の最大絶対値を持つ要素 (p, q) を探す (p < q)
		let p = 0
		let q = 1
		let maxOff = Math.abs(A[0][1])
		if (Math.abs(A[0][2]) > maxOff) {
			p = 0
			q = 2
			maxOff = Math.abs(A[0][2])
		}
		if (Math.abs(A[1][2]) > maxOff) {
			p = 1
			q = 2
			maxOff = Math.abs(A[1][2])
		}
		if (maxOff < tol) break

		// A[p][q] をゼロにする回転角を計算 (古典 Jacobi の式)
		const app = A[p][p]
		const aqq = A[q][q]
		const apq = A[p][q]
		const theta = (aqq - app) / (2 * apq)
		const t =
			theta >= 0
				? 1 / (theta + Math.sqrt(1 + theta * theta))
				: 1 / (theta - Math.sqrt(1 + theta * theta))
		const c = 1 / Math.sqrt(1 + t * t)
		const s = t * c

		// A を両側回転で更新
		A[p][p] = app - t * apq
		A[q][q] = aqq + t * apq
		A[p][q] = 0
		A[q][p] = 0
		for (let i = 0; i < 3; i++) {
			if (i !== p && i !== q) {
				const aip = A[i][p]
				const aiq = A[i][q]
				A[i][p] = c * aip - s * aiq
				A[p][i] = A[i][p]
				A[i][q] = s * aip + c * aiq
				A[q][i] = A[i][q]
			}
		}
		// V も同じ回転を右から適用
		for (let i = 0; i < 3; i++) {
			const vip = V[i][p]
			const viq = V[i][q]
			V[i][p] = c * vip - s * viq
			V[i][q] = s * vip + c * viq
		}
	}
	return { D: [A[0][0], A[1][1], A[2][2]], V }
}

/**
 * 3×3 直交行列 (純粋回転) → unit quaternion `(x, y, z, w)`。 Shepperd 法 (trace ベースの場合分け)。
 */
function quaternionFromMatrix3(M: readonly number[][]): [number, number, number, number] {
	const m00 = M[0][0]
	const m11 = M[1][1]
	const m22 = M[2][2]
	const tr = m00 + m11 + m22
	let x: number, y: number, z: number, w: number
	if (tr > 0) {
		const s = 2 * Math.sqrt(tr + 1)
		w = 0.25 * s
		x = (M[2][1] - M[1][2]) / s
		y = (M[0][2] - M[2][0]) / s
		z = (M[1][0] - M[0][1]) / s
	} else if (m00 > m11 && m00 > m22) {
		const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
		w = (M[2][1] - M[1][2]) / s
		x = 0.25 * s
		y = (M[0][1] + M[1][0]) / s
		z = (M[0][2] + M[2][0]) / s
	} else if (m11 > m22) {
		const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
		w = (M[0][2] - M[2][0]) / s
		x = (M[0][1] + M[1][0]) / s
		y = 0.25 * s
		z = (M[1][2] + M[2][1]) / s
	} else {
		const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
		w = (M[1][0] - M[0][1]) / s
		x = (M[0][2] + M[2][0]) / s
		y = (M[1][2] + M[2][1]) / s
		z = 0.25 * s
	}
	return [x, y, z, w]
}

function transpose3(M: readonly number[][]): number[][] {
	return [
		[M[0][0], M[1][0], M[2][0]],
		[M[0][1], M[1][1], M[2][1]],
		[M[0][2], M[1][2], M[2][2]],
	]
}

function matMul3(A: readonly number[][], B: readonly number[][]): number[][] {
	const R: number[][] = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	]
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) {
			R[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]
		}
	}
	return R
}

function determinant3(M: readonly number[][]): number {
	return (
		M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
		M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
		M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])
	)
}
