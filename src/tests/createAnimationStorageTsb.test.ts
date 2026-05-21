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

/** A bone transform; only the `decomposed` channels are read by the generator. */
function boneT(t: Vec3, r: Quat, s: Vec3): INodeTransform {
	return {
		decomposed: {
			translation: { x: t[0], y: t[1], z: t[2] },
			left_rotation: { x: r[0], y: r[1], z: r[2], w: r[3] },
			scale: { x: s[0], y: s[1], z: s[2] },
		},
	} as unknown as INodeTransform
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
				'data remove storage aj.demo_boss:anim',
				'data remove storage aj.demo_boss:variants',
				'data remove storage aj.demo_boss:state',
				'data remove storage aj.demo_boss:tmp'
			),
			[`${P}/expand/idle/p0.mcfunction`]: mc(
				'$data modify storage aj.demo_boss:anim idle.bones.0$(_) set value {"0":[0f,0f,0f,0f,0f,0f,1f,1f,1f,1f],"1":[0f,.1f,0f,0f,.087f,0f,.996f,1f,1f,1f],"2":[0f,0f,0f,0f,0f,0f,1f,1f,1f,1f]}',
				'$data modify storage aj.demo_boss:anim idle.bones.1$(_) set value {"0":[0f,0f,0f,0f,0f,0f,1f,1f,1f,1f],"1":[0f,0f,0f,0f,0f,0f,1f,1f,1f,1f],"2":[0f,0f,0f,0f,0f,0f,1f,1f,1f,1f]}',
				'$data modify storage aj.demo_boss:anim idle.bones.2$(_) set value {"0":[.5f,0f,0f,0f,0f,0f,1f,1f,1f,1f],"1":[.5f,0f,0f,0f,.052f,0f,.999f,1f,1f,1f],"2":[.5f,0f,0f,0f,0f,0f,1f,1f,1f,1f]}',
				'$data modify storage aj.demo_boss:anim idle.locators.0$(_) set value {"0":[0f,1.5f,0f,0f,0f],"1":[0f,1.5f,0f,5f,10f],"2":[0f,1.5f,0f,0f,0f]}',
				'$data modify storage aj.demo_boss:state loaded.idle$(_) set value 1b'
			),
			[`${P}/expand/attack/p0.mcfunction`]: mc(
				'$data modify storage aj.demo_boss:anim attack.bones.0$(_) set value {"0":[0f,0f,0f,0f,0f,0f,1f,1f,1f,1f],"1":[0f,0f,0f,0f,.174f,0f,.985f,1f,1f,1f],"2":[0f,.3f,0f,.087f,.342f,.025f,.935f,1f,1f,1f],"3":[0f,.2f,0f,0f,.342f,0f,.94f,1f,1f,1f],"4":[0f,0f,0f,0f,0f,0f,1f,1f,1f,1f]}',
				'$data modify storage aj.demo_boss:anim attack.bones.1$(_) set value {"0":[0f,0f,0f,0f,0f,0f,1f,1f,1f,1f],"1":[0f,0f,0f,0f,0f,0f,1f,1f,1f,1f],"2":[0f,0f,0f,0f,0f,0f,1f,1f,1f,1f],"3":[0f,0f,0f,0f,0f,0f,1f,1f,1f,1f],"4":[0f,0f,0f,0f,0f,0f,1f,1f,1f,1f]}',
				'$data modify storage aj.demo_boss:anim attack.bones.2$(_) set value {"0":[.5f,0f,0f,0f,0f,0f,1f,1f,1f,1f],"1":[.5f,0f,0f,0f,0f,.259f,.966f,1f,1f,1f],"2":[.5f,0f,0f,0f,0f,.5f,.866f,1f,1f,1f],"3":[.5f,0f,0f,0f,0f,.259f,.966f,1f,1f,1f],"4":[.5f,0f,0f,0f,0f,0f,1f,1f,1f,1f]}',
				'$data modify storage aj.demo_boss:anim attack.locators.0$(_) set value {"0":[0f,1.5f,0f,0f,0f],"1":[0f,1.5f,0f,10f,0f],"2":[.05f,1.5f,.3f,30f,0f],"3":[0f,1.5f,0f,15f,0f],"4":[0f,1.5f,0f,0f,0f]}',
				'$data modify storage aj.demo_boss:state loaded.attack$(_) set value 1b'
			),
			[`${P}/force_load/idle.mcfunction`]: mc('function aj:demo_boss/expand/idle/p0 {_: ""}'),
			[`${P}/force_load/attack.mcfunction`]: mc(
				'function aj:demo_boss/expand/attack/p0 {_: ""}'
			),
			[`${P}/expand_variants/attack.mcfunction`]: mc(
				'$data modify storage aj.demo_boss:variants attack$(_) set value {"0":{name:"damaged",condition:""}}',
				'$data modify storage aj.demo_boss:state loaded_variants.attack$(_) set value 1b'
			),
			[`${P}/load/init_queue.mcfunction`]: mc(
				'data modify storage aj.demo_boss:state queue.immediate set value []',
				'data modify storage aj.demo_boss:state queue.high set value []',
				'data modify storage aj.demo_boss:state queue.low set value ["aj:demo_boss/expand/idle/p0","aj:demo_boss/expand/attack/p0","aj:demo_boss/expand_variants/attack"]',
				'schedule function aj:demo_boss/load/tick 1t replace'
			),
			[`${P}/load/tick.mcfunction`]: mc(
				'execute if data storage aj.demo_boss:state queue.immediate[0] run return run function aj:demo_boss/load/pop/immediate',
				'execute if data storage aj.demo_boss:state queue.high[0] run return run function aj:demo_boss/load/pop/high',
				'execute if data storage aj.demo_boss:state queue.low[0] run function aj:demo_boss/load/pop/low',
				'',
				'execute if data storage aj.demo_boss:state queue.immediate[0] run schedule function aj:demo_boss/load/tick 1t replace',
				'execute unless data storage aj.demo_boss:state queue.immediate[0] if data storage aj.demo_boss:state queue.high[0] run schedule function aj:demo_boss/load/tick 1t replace',
				'execute unless data storage aj.demo_boss:state queue.immediate[0] unless data storage aj.demo_boss:state queue.high[0] if data storage aj.demo_boss:state queue.low[0] run schedule function aj:demo_boss/load/tick 1t replace'
			),
			[`${P}/load/pop/immediate.mcfunction`]: mc(
				'data modify storage aj.demo_boss:tmp pop set from storage aj.demo_boss:state queue.immediate[0]',
				'data remove storage aj.demo_boss:state queue.immediate[0]',
				'function aj:demo_boss/load/dispatch with storage aj.demo_boss:tmp'
			),
			[`${P}/load/pop/high.mcfunction`]: mc(
				'data modify storage aj.demo_boss:tmp pop set from storage aj.demo_boss:state queue.high[0]',
				'data remove storage aj.demo_boss:state queue.high[0]',
				'function aj:demo_boss/load/dispatch with storage aj.demo_boss:tmp'
			),
			[`${P}/load/pop/low.mcfunction`]: mc(
				'data modify storage aj.demo_boss:tmp pop set from storage aj.demo_boss:state queue.low[0]',
				'data remove storage aj.demo_boss:state queue.low[0]',
				'function aj:demo_boss/load/dispatch with storage aj.demo_boss:tmp'
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
		expect(p0).not.toContain('loaded.run')
		expect(p1).toContain('$data modify storage aj.demo:state loaded.run$(_) set value 1b')

		// p0 carries bones a (id 0) and b (id 1); p1 carries bone c (id 2)
		expect(p0).toContain('run.bones.0$(_)')
		expect(p0).toContain('run.bones.1$(_)')
		expect(p0).not.toContain('run.bones.2$(_)')
		expect(p1).toContain('run.bones.2$(_)')

		// force_load runs every batch immediately
		expect(result.files.get('data/aj/functions/demo/force_load/run.mcfunction')!.content).toBe(
			'function aj:demo/expand/run/p0 {_: ""}\n' + 'function aj:demo/expand/run/p1 {_: ""}\n'
		)

		// init_queue enqueues every batch into queue.low (Phase B-1 behaviour)
		expect(
			result.files.get('data/aj/functions/demo/load/init_queue.mcfunction')!.content
		).toContain('queue.low set value ["aj:demo/expand/run/p0","aj:demo/expand/run/p1"]')
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
	it('trims leading/trailing zeros and keeps the sign on negatives', async () => {
		const rig = { nodes: { a: boneNode('a') }, variants: {} } as unknown as IRenderedRig
		const anim = makeAnimation(
			'q',
			[frame({ a: boneT([-0.5, 0.00001, 1], [0, 0, 0, 1], [1.5, 0, -1.25]) })],
			['a']
		)

		const result = await createAnimationStorageTsb(rig, [anim], {
			blueprintId: 'aj:demo',
			quantizationDigits: 5,
			cellsPerTick: 1000,
			maxLineBytes: 1_000_000,
		})

		const content = result.files.get('data/aj/functions/demo/expand/q/p0.mcfunction')!.content
		expect(content).toContain('"0":[-.5f,.00001f,1f,0f,0f,0f,1f,1.5f,0f,-1.25f]')
	})
})
