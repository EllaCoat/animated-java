/**
 * Headless generation verification for TSB Optimized Export (Phase B-1).
 *
 * `createAnimationStorageTsb` consumes only plain IRenderedRig / IRenderedAnimation
 * data structures, so it can be exercised without the Blockbench runtime. These
 * tests reproduce the `demo_boss` minimal example from tsb-output-sample.md and
 * assert the generated mcfunction files byte-for-byte, then cover batch
 * splitting, the MAX_LINE_BYTES sanity check and float quantization.
 *
 * Note: init_queue / tick / pop follow the Phase B-1 spec (all animations are
 * enqueued into queue.low; priority routing is not implemented yet), which is
 * what the verification checklist describes.
 */
import { describe, expect, it, vi } from 'vitest'

// minecraftUtil transitively imports Blockbench-coupled modules. Only
// parseResourceLocation is needed here, so stub it with a faithful minimal copy.
vi.mock('../util/minecraftUtil', () => ({
	parseResourceLocation(resourceLocation: string) {
		let [namespace, ...parts] = resourceLocation.split(':')
		if (parts.length === 0) {
			parts = [namespace]
			namespace = 'minecraft'
		}
		return { namespace, path: parts.join('') }
	},
}))

import { createAnimationStorageTsb } from '../systems/datapackCompiler/createAnimationStorageTsb'
import type { INodeTransform, IRenderedAnimation } from '../systems/animationRenderer'
import type { IRenderedRig } from '../systems/rigRenderer'

// --- fixture builders -------------------------------------------------------

type Vec3 = [number, number, number]
type Quat = [number, number, number, number]

/**
 * A bone transform fixture. The generator now SVD-decomposes `matrix.elements` per cell to
 * pick between 7 / 10 / 14 floats, so we synthesise a column-major 4×4 matrix from the
 * provided TRS (with right_rotation = identity, which keeps the round-trip exact).
 */
function boneT(t: Vec3, r: Quat, s: Vec3): INodeTransform {
	// 概数で書かれた quaternion を正規化 (production 経路では Blockbench が常に unit quaternion を保証するが、
	// テスト fixture では手書き値の norm 微小ズレが SVD の sigma に乗って scale_class 判定を狂わせるため)。
	const rNorm = normalizeQuat(r)
	const elements = composeMatrix16(t, rNorm, s, [0, 0, 0, 1])
	return {
		matrix: { elements } as unknown as THREE.Matrix4,
		decomposed: {
			translation: { x: t[0], y: t[1], z: t[2] },
			left_rotation: { x: rNorm[0], y: rNorm[1], z: rNorm[2], w: rNorm[3] },
			scale: { x: s[0], y: s[1], z: s[2] },
		},
	} as unknown as INodeTransform
}

function normalizeQuat(q: Quat): Quat {
	const n = Math.hypot(q[0], q[1], q[2], q[3])
	if (n === 0) return [0, 0, 0, 1]
	return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

/** Build a column-major 4×4 matrix from `T · R_left · S · R_right` (right_rotation defaults to identity). */
function composeMatrix16(
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
	const RlS = matMul3(Rl, S)
	const M = matMul3(RlS, Rr)
	return [
		M[0][0], M[1][0], M[2][0], 0,
		M[0][1], M[1][1], M[2][1], 0,
		M[0][2], M[1][2], M[2][2], 0,
		t[0], t[1], t[2], 1,
	]
}

function matFromQuat(q: readonly [number, number, number, number]): number[][] {
	const [x, y, z, w] = q
	const xx = x * x, yy = y * y, zz = z * z
	const xy = x * y, xz = x * z, yz = y * z
	const wx = w * x, wy = w * y, wz = w * z
	return [
		[1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
		[2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
		[2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
	]
}

function matMul3(A: readonly number[][], B: readonly number[][]): number[][] {
	const R: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++) R[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]
	return R
}

/** A locator transform; the generator reads pos[0..2] and rot[0..1]. */
function locT(pos: Vec3, rot: [number, number]): INodeTransform {
	return { pos: [...pos], rot: [rot[0], rot[1], 0] } as unknown as INodeTransform
}

function boneNode(uuid: string) {
	return { uuid, storage_name: uuid, type: 'bone' }
}
function locatorNode(uuid: string) {
	return { uuid, storage_name: uuid, type: 'locator' }
}

function frame(node_transforms: Record<string, INodeTransform>, variants?: string[]) {
	return { time: 0, node_transforms, ...(variants ? { variants } : {}) }
}

function makeAnimation(
	storage_name: string,
	frames: ReturnType<typeof frame>[],
	modifiedUuids: string[]
): IRenderedAnimation {
	const modified_nodes: Record<string, unknown> = {}
	for (const u of modifiedUuids) modified_nodes[u] = { uuid: u }
	return {
		name: storage_name,
		storage_name,
		uuid: storage_name,
		frames,
		duration: frames.length,
		modified_nodes,
	} as unknown as IRenderedAnimation
}

/** lines joined with \n plus a trailing \n, matching the generator's output. */
const mc = (...lines: string[]): string => lines.join('\n') + '\n'

// --- shared reusable transforms --------------------------------------------

const IDENT = boneT([0, 0, 0], [0, 0, 0, 1], [1, 1, 1])
const ARM_REST = boneT([0.5, 0, 0], [0, 0, 0, 1], [1, 1, 1])

// --- demo_boss fixture (tsb-output-sample.md) ------------------------------

function demoBossRig(): IRenderedRig {
	return {
		nodes: {
			head: boneNode('head'),
			body: boneNode('body'),
			arm_l: boneNode('arm_l'),
			muzzle: locatorNode('muzzle'),
		},
		variants: {
			damaged: { name: 'damaged' },
		},
	} as unknown as IRenderedRig
}

function idleAnimation(): IRenderedAnimation {
	return makeAnimation(
		'idle',
		[
			frame({ head: IDENT, body: IDENT, arm_l: ARM_REST, muzzle: locT([0, 1.5, 0], [0, 0]) }),
			frame({
				head: boneT([0, 0.1, 0], [0, 0.087, 0, 0.996], [1, 1, 1]),
				body: IDENT,
				arm_l: boneT([0.5, 0, 0], [0, 0.052, 0, 0.999], [1, 1, 1]),
				muzzle: locT([0, 1.5, 0], [5, 10]),
			}),
			frame({ head: IDENT, body: IDENT, arm_l: ARM_REST, muzzle: locT([0, 1.5, 0], [0, 0]) }),
		],
		['head', 'body', 'arm_l', 'muzzle']
	)
}

function attackAnimation(): IRenderedAnimation {
	return makeAnimation(
		'attack',
		[
			frame(
				{ head: IDENT, body: IDENT, arm_l: ARM_REST, muzzle: locT([0, 1.5, 0], [0, 0]) },
				['damaged']
			),
			frame({
				head: boneT([0, 0, 0], [0, 0.174, 0, 0.985], [1, 1, 1]),
				body: IDENT,
				arm_l: boneT([0.5, 0, 0], [0, 0, 0.259, 0.966], [1, 1, 1]),
				muzzle: locT([0, 1.5, 0], [10, 0]),
			}),
			frame({
				head: boneT([0, 0.3, 0], [0.087, 0.342, 0.025, 0.935], [1, 1, 1]),
				body: IDENT,
				arm_l: boneT([0.5, 0, 0], [0, 0, 0.5, 0.866], [1, 1, 1]),
				muzzle: locT([0.05, 1.5, 0.3], [30, 0]),
			}),
			frame({
				head: boneT([0, 0.2, 0], [0, 0.342, 0, 0.94], [1, 1, 1]),
				body: IDENT,
				arm_l: boneT([0.5, 0, 0], [0, 0, 0.259, 0.966], [1, 1, 1]),
				muzzle: locT([0, 1.5, 0], [15, 0]),
			}),
			frame({ head: IDENT, body: IDENT, arm_l: ARM_REST, muzzle: locT([0, 1.5, 0], [0, 0]) }),
		],
		['head', 'body', 'arm_l', 'muzzle']
	)
}

describe('createAnimationStorageTsb - demo_boss minimal example', () => {
	it('generates the exact datapack file set described in tsb-output-sample.md', async () => {
		const result = await createAnimationStorageTsb(
			demoBossRig(),
			[idleAnimation(), attackAnimation()],
			{
				blueprintId: 'aj:demo_boss',
				quantizationDigits: 5,
				cellsPerTick: 1000,
				maxLineBytes: 1_000_000,
			}
		)

		const P = 'data/aj/functions/demo_boss'
		const expected: Record<string, string> = {
			[`${P}/_bone_id_mapping.mcfunction`]: mc(
				'# Bone / locator ID mapping for blueprint aj:demo_boss (generated by Animated Java TSB Optimized Export).',
				'# This file is documentation only and is not executed at runtime.',
				'#',
				'# [bones]',
				'# 0: head',
				'# 1: body',
				'# 2: arm_l',
				'#',
				'# [locators]',
				'# 0: muzzle'
			),
			[`${P}/cleanup.mcfunction`]: mc(
				'execute if data storage aj.demo_boss:anim d run data remove storage aj.demo_boss:anim d',
				'execute if data storage aj.demo_boss:variants d run data remove storage aj.demo_boss:variants d',
				'execute if data storage aj.demo_boss:state d run data remove storage aj.demo_boss:state d',
				'execute if data storage aj.demo_boss:tmp d run data remove storage aj.demo_boss:tmp d'
			),
			[`${P}/expand/idle/p0.mcfunction`]: mc(
				'$data modify storage aj.demo_boss:anim d.idle.bones.0$(_) set value {"0":[0f,0f,0f,0f,0f,0f,1f],"1":[0f,.1f,0f,0f,.08702f,0f,.99621f],"2":[0f,0f,0f,0f,0f,0f,1f]}',
				'$data modify storage aj.demo_boss:anim d.idle.bones.1$(_) set value {"0":[0f,0f,0f,0f,0f,0f,1f],"1":[0f,0f,0f,0f,0f,0f,1f],"2":[0f,0f,0f,0f,0f,0f,1f]}',
				'$data modify storage aj.demo_boss:anim d.idle.bones.2$(_) set value {"0":[.5f,0f,0f,0f,0f,0f,1f],"1":[.5f,0f,0f,0f,.05198f,0f,.99865f],"2":[.5f,0f,0f,0f,0f,0f,1f]}',
				'$data modify storage aj.demo_boss:anim d.idle.locators.0$(_) set value {"0":[0f,1.5f,0f,0f,0f],"1":[0f,1.5f,0f,5f,10f],"2":[0f,1.5f,0f,0f,0f]}',
				'$data modify storage aj.demo_boss:state d.loaded.idle$(_) set value 1b'
			),
			[`${P}/expand/attack/p0.mcfunction`]: mc(
				'$data modify storage aj.demo_boss:anim d.attack.bones.0$(_) set value {"0":[0f,0f,0f,0f,0f,0f,1f],"1":[0f,0f,0f,0f,.17396f,0f,.98475f],"2":[0f,.3f,0f,.08703f,.34211f,.02501f,.93529f],"3":[0f,.2f,0f,0f,.3419f,0f,.93974f],"4":[0f,0f,0f,0f,0f,0f,1f]}',
				'$data modify storage aj.demo_boss:anim d.attack.bones.1$(_) set value {"0":[0f,0f,0f,0f,0f,0f,1f],"1":[0f,0f,0f,0f,0f,0f,1f],"2":[0f,0f,0f,0f,0f,0f,1f],"3":[0f,0f,0f,0f,0f,0f,1f],"4":[0f,0f,0f,0f,0f,0f,1f]}',
				'$data modify storage aj.demo_boss:anim d.attack.bones.2$(_) set value {"0":[.5f,0f,0f,0f,0f,0f,1f],"1":[.5f,0f,0f,0f,0f,.25897f,.96589f],"2":[.5f,0f,0f,0f,0f,.50001f,.86602f],"3":[.5f,0f,0f,0f,0f,.25897f,.96589f],"4":[.5f,0f,0f,0f,0f,0f,1f]}',
				'$data modify storage aj.demo_boss:anim d.attack.locators.0$(_) set value {"0":[0f,1.5f,0f,0f,0f],"1":[0f,1.5f,0f,10f,0f],"2":[.05f,1.5f,.3f,30f,0f],"3":[0f,1.5f,0f,15f,0f],"4":[0f,1.5f,0f,0f,0f]}',
				'$data modify storage aj.demo_boss:state d.loaded.attack$(_) set value 1b'
			),
			[`${P}/force_load/idle.mcfunction`]: mc('function aj:demo_boss/expand/idle/p0 {_: ""}'),
			[`${P}/force_load/attack.mcfunction`]: mc(
				'function aj:demo_boss/expand/attack/p0 {_: ""}'
			),
			[`${P}/expand_variants/attack.mcfunction`]: mc(
				'$data modify storage aj.demo_boss:variants d.attack$(_) set value {"0":{name:"damaged",condition:""}}',
				'$data modify storage aj.demo_boss:state d.loaded_variants.attack$(_) set value 1b'
			),
			[`${P}/load/init_queue.mcfunction`]: mc(
				'data modify storage aj.demo_boss:state d.queue.immediate set value []',
				'data modify storage aj.demo_boss:state d.queue.high set value []',
				'data modify storage aj.demo_boss:state d.queue.low set value ["aj:demo_boss/expand/idle/p0","aj:demo_boss/expand/attack/p0","aj:demo_boss/expand_variants/attack"]',
				'schedule function aj:demo_boss/load/tick 1t replace'
			),
			[`${P}/load/tick.mcfunction`]: mc(
				'execute if data storage aj.demo_boss:state d.queue.immediate[0] run return run function aj:demo_boss/load/pop/immediate',
				'execute if data storage aj.demo_boss:state d.queue.high[0] run return run function aj:demo_boss/load/pop/high',
				'execute if data storage aj.demo_boss:state d.queue.low[0] run function aj:demo_boss/load/pop/low',
				'',
				'execute if data storage aj.demo_boss:state d.queue.immediate[0] run schedule function aj:demo_boss/load/tick 1t replace',
				'execute unless data storage aj.demo_boss:state d.queue.immediate[0] if data storage aj.demo_boss:state d.queue.high[0] run schedule function aj:demo_boss/load/tick 1t replace',
				'execute unless data storage aj.demo_boss:state d.queue.immediate[0] unless data storage aj.demo_boss:state d.queue.high[0] if data storage aj.demo_boss:state d.queue.low[0] run schedule function aj:demo_boss/load/tick 1t replace'
			),
			[`${P}/load/pop/immediate.mcfunction`]: mc(
				'data modify storage aj.demo_boss:tmp d.pop set from storage aj.demo_boss:state d.queue.immediate[0]',
				'data remove storage aj.demo_boss:state d.queue.immediate[0]',
				'function aj:demo_boss/load/dispatch with storage aj.demo_boss:tmp d'
			),
			[`${P}/load/pop/high.mcfunction`]: mc(
				'data modify storage aj.demo_boss:tmp d.pop set from storage aj.demo_boss:state d.queue.high[0]',
				'data remove storage aj.demo_boss:state d.queue.high[0]',
				'function aj:demo_boss/load/dispatch with storage aj.demo_boss:tmp d'
			),
			[`${P}/load/pop/low.mcfunction`]: mc(
				'data modify storage aj.demo_boss:tmp d.pop set from storage aj.demo_boss:state d.queue.low[0]',
				'data remove storage aj.demo_boss:state d.queue.low[0]',
				'function aj:demo_boss/load/dispatch with storage aj.demo_boss:tmp d'
			),
			[`${P}/load/dispatch.mcfunction`]: mc('$function $(pop) {_: ""}'),
		}

		// ExportedFile.content is `string | Buffer`; the TSB generator only ever
		// emits string content, but keep the wider type to stay type-clean.
		const actual: Record<string, string | Buffer> = {}
		for (const [path, file] of result.files) actual[path] = file.content

		expect(actual).toEqual(expected)
		expect(result.animationStorage).toEqual([])
	})
})

describe('createAnimationStorageTsb - batch splitting (cells_per_tick)', () => {
	it('splits one animation into multiple expand batches and marks only the last', async () => {
		const rig = {
			nodes: { a: boneNode('a'), b: boneNode('b'), c: boneNode('c') },
			variants: {},
		} as unknown as IRenderedRig
		// duration 5 => 5 cells per bone; cellsPerTick 10 => batches [a,b] and [c]
		const anim = makeAnimation(
			'run',
			[0, 1, 2, 3, 4].map(() => frame({ a: IDENT, b: IDENT, c: IDENT })),
			['a', 'b', 'c']
		)

		const result = await createAnimationStorageTsb(rig, [anim], {
			blueprintId: 'aj:demo',
			quantizationDigits: 5,
			cellsPerTick: 10,
			maxLineBytes: 1_000_000,
		})

		const paths = [...result.files.keys()]
		expect(paths).toContain('data/aj/functions/demo/expand/run/p0.mcfunction')
		expect(paths).toContain('data/aj/functions/demo/expand/run/p1.mcfunction')
		expect(paths).not.toContain('data/aj/functions/demo/expand/run/p2.mcfunction')

		const p0 = result.files.get('data/aj/functions/demo/expand/run/p0.mcfunction')!.content
		const p1 = result.files.get('data/aj/functions/demo/expand/run/p1.mcfunction')!.content

		// completion mark belongs only to the final batch
		expect(p0).not.toContain('d.loaded.run')
		expect(p1).toContain('$data modify storage aj.demo:state d.loaded.run$(_) set value 1b')

		// p0 carries bones a (id 0) and b (id 1); p1 carries bone c (id 2)
		expect(p0).toContain('d.run.bones.0$(_)')
		expect(p0).toContain('d.run.bones.1$(_)')
		expect(p0).not.toContain('d.run.bones.2$(_)')
		expect(p1).toContain('d.run.bones.2$(_)')

		// force_load runs every batch immediately
		expect(result.files.get('data/aj/functions/demo/force_load/run.mcfunction')!.content).toBe(
			'function aj:demo/expand/run/p0 {_: ""}\n' + 'function aj:demo/expand/run/p1 {_: ""}\n'
		)

		// init_queue enqueues every batch into queue.low (Phase B-1 behaviour)
		expect(
			result.files.get('data/aj/functions/demo/load/init_queue.mcfunction')!.content
		).toContain('d.queue.low set value ["aj:demo/expand/run/p0","aj:demo/expand/run/p1"]')
	})
})

describe('createAnimationStorageTsb - MAX_LINE_BYTES sanity check', () => {
	it('throws a [TSB] error when a bone line exceeds the byte limit', async () => {
		const rig = { nodes: { a: boneNode('a') }, variants: {} } as unknown as IRenderedRig
		const anim = makeAnimation('big', [frame({ a: IDENT }), frame({ a: IDENT })], ['a'])

		await expect(
			createAnimationStorageTsb(rig, [anim], {
				blueprintId: 'aj:demo',
				quantizationDigits: 5,
				cellsPerTick: 1000,
				maxLineBytes: 30,
			})
		).rejects.toThrow(/^\[TSB\] Animation 'big'/)
	})
})

describe('createAnimationStorageTsb - float quantization', () => {
	it('trims leading/trailing zeros and keeps the sign on negatives (identity scale → 7 floats)', async () => {
		const rig = { nodes: { a: boneNode('a') }, variants: {} } as unknown as IRenderedRig
		// identity scale を維持しつつ、 translation と rotation でマイナス値 / 5 桁小数 / 整数値ゼロを混ぜる。
		// rotation (0, -0.5, 0, sqrt(3)/2) は単位 quaternion (Y 軸 -60°)。
		const cos30 = Math.sqrt(3) / 2 // ≒ 0.86603 (5 桁丸めで .86603f)
		const anim = makeAnimation(
			'q',
			[frame({ a: boneT([-0.5, 0.00001, 1], [0, -0.5, 0, cos30], [1, 1, 1]) })],
			['a']
		)

		const result = await createAnimationStorageTsb(rig, [anim], {
			blueprintId: 'aj:demo',
			quantizationDigits: 5,
			cellsPerTick: 1000,
			maxLineBytes: 1_000_000,
		})

		const content = result.files.get('data/aj/functions/demo/expand/q/p0.mcfunction')!.content
		// translation: -.5f / .00001f / 1f, rotation: 0f / -.5f / 0f / .86603f, scale 省略 (identity → 7 floats)
		expect(content).toContain('"0":[-.5f,.00001f,1f,0f,-.5f,0f,.86603f]')
	})

	it('outputs 10 floats for uniform non-identity scale', async () => {
		const rig = { nodes: { a: boneNode('a') }, variants: {} } as unknown as IRenderedRig
		const anim = makeAnimation('q', [frame({ a: boneT([0, 0, 0], [0, 0, 0, 1], [2, 2, 2]) })], ['a'])

		const result = await createAnimationStorageTsb(rig, [anim], {
			blueprintId: 'aj:demo',
			quantizationDigits: 5,
			cellsPerTick: 1000,
			maxLineBytes: 1_000_000,
		})

		const content = result.files.get('data/aj/functions/demo/expand/q/p0.mcfunction')!.content
		expect(content).toContain('"0":[0f,0f,0f,0f,0f,0f,1f,2f,2f,2f]')
	})

	it('outputs 14 floats for non-uniform scale (no shear)', async () => {
		const rig = { nodes: { a: boneNode('a') }, variants: {} } as unknown as IRenderedRig
		const anim = makeAnimation('q', [frame({ a: boneT([0, 0, 0], [0, 0, 0, 1], [2, 3, 4]) })], ['a'])

		const result = await createAnimationStorageTsb(rig, [anim], {
			blueprintId: 'aj:demo',
			quantizationDigits: 5,
			cellsPerTick: 1000,
			maxLineBytes: 1_000_000,
		})

		const content = result.files.get('data/aj/functions/demo/expand/q/p0.mcfunction')!.content
		// 14 floats: translation + left_rotation + scale + right_rotation
		// scale が pure diagonal (no shear) なら R_left = R_right = identity に取れるはず
		// SVD は降順で sigma を並べるため scale は (4, 3, 2) の順で出る (R_left / R_right はそれを補う回転)
		// 配列長だけ確認 (具体値は SVD 自由度のため固定しない)
		const match = content.match(/"0":\[([^\]]+)\]/)
		expect(match).not.toBeNull()
		const floatCount = match![1].split(',').length
		expect(floatCount).toBe(14)
	})
})
