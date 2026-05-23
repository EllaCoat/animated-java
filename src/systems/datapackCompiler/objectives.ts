namespace OBJECTIVES {
	export const I = () => 'aj.i'
	export const ID = () => 'aj.id'
	export const FRAME = (animationName: string) => `aj.${animationName}.frame`
	export const IS_RIG_LOADED = () => 'aj.is_rig_loaded'
	export const TWEEN_DURATION = () => 'aj.tween_duration'
	// blueprintId は `namespace:path` 形式 (例: `aj:axia`)。 objective 名に `:` は使えないため
	// `.` に置換する (既存 `project_storage.replace(':', '.')` パターンと整合)。
	export const DUR = (blueprintId: string) =>
		`aj.${blueprintId.replace(':', '.')}.dur`
	export const TP_DUR = (blueprintId: string) =>
		`aj.${blueprintId.replace(':', '.')}.tp_dur`
	export const CURRENT_ANIM = (blueprintId: string) =>
		`aj.${blueprintId.replace(':', '.')}.current_anim`
	export const BONE_ID = (blueprintId: string) =>
		`aj.${blueprintId.replace(':', '.')}.bone_id`
	export const LOCATOR_ID = (blueprintId: string) =>
		`aj.${blueprintId.replace(':', '.')}.locator_id`
}

export default OBJECTIVES
