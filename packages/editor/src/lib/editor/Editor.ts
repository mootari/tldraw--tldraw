import { EMPTY_ARRAY, atom, computed, transact } from '@tldraw/state'
import { ComputedCache, RecordType, StoreSnapshot } from '@tldraw/store'
import {
	CameraRecordType,
	InstancePageStateRecordType,
	PageRecordType,
	StyleProp,
	StylePropValue,
	TLArrowShape,
	TLAsset,
	TLAssetId,
	TLAssetPartial,
	TLCursor,
	TLCursorType,
	TLDOCUMENT_ID,
	TLDocument,
	TLFrameShape,
	TLGeoShape,
	TLGroupShape,
	TLHandle,
	TLINSTANCE_ID,
	TLImageAsset,
	TLInstance,
	TLInstancePageState,
	TLPOINTER_ID,
	TLPage,
	TLPageId,
	TLParentId,
	TLRecord,
	TLShape,
	TLShapeId,
	TLShapePartial,
	TLStore,
	TLUnknownShape,
	TLVideoAsset,
	createShapeId,
	getShapePropKeysByStyle,
	isPageId,
	isShapeId,
} from '@tldraw/tlschema'
import {
	IndexKey,
	JsonObject,
	annotateError,
	assert,
	compact,
	dedupe,
	getIndexAbove,
	getIndexBetween,
	getIndices,
	getIndicesAbove,
	getIndicesBetween,
	getOwnProperty,
	hasOwnProperty,
	sortById,
	sortByIndex,
	structuredClone,
} from '@tldraw/utils'
import { EventEmitter } from 'eventemitter3'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { TLUser, createTLUser } from '../config/createTLUser'
import { checkShapesAndAddCore } from '../config/defaultShapes'
import {
	ANIMATION_MEDIUM_MS,
	CAMERA_MOVING_TIMEOUT,
	CAMERA_SLIDE_FRICTION,
	COARSE_DRAG_DISTANCE,
	COLLABORATOR_IDLE_TIMEOUT,
	DEFAULT_ANIMATION_OPTIONS,
	DRAG_DISTANCE,
	FOLLOW_CHASE_PAN_SNAP,
	FOLLOW_CHASE_PAN_UNSNAP,
	FOLLOW_CHASE_PROPORTION,
	FOLLOW_CHASE_ZOOM_SNAP,
	FOLLOW_CHASE_ZOOM_UNSNAP,
	HIT_TEST_MARGIN,
	INTERNAL_POINTER_IDS,
	LONG_PRESS_DURATION,
	MAX_PAGES,
	MAX_SHAPES_PER_PAGE,
	MAX_ZOOM,
	MIN_ZOOM,
	ZOOMS,
} from '../constants'
import { Box } from '../primitives/Box'
import { Mat, MatLike, MatModel } from '../primitives/Mat'
import { Vec, VecLike } from '../primitives/Vec'
import { EASINGS } from '../primitives/easings'
import { Geometry2d } from '../primitives/geometry/Geometry2d'
import { Group2d } from '../primitives/geometry/Group2d'
import { intersectPolygonPolygon } from '../primitives/intersect'
import { PI2, approximately, areAnglesCompatible, clamp, pointInPolygon } from '../primitives/utils'
import { ReadonlySharedStyleMap, SharedStyle, SharedStyleMap } from '../utils/SharedStylesMap'
import { WeakMapCache } from '../utils/WeakMapCache'
import { dataUrlToFile } from '../utils/assets'
import { getIncrementedName } from '../utils/getIncrementedName'
import { getReorderingShapesChanges } from '../utils/reorderShapes'
import { applyRotationToSnapshotShapes, getRotationSnapshot } from '../utils/rotation'
import { uniqueId } from '../utils/uniqueId'
import { arrowBindingsIndex } from './derivations/arrowBindingsIndex'
import { notVisibleShapes } from './derivations/notVisibleShapes'
import { parentsToChildren } from './derivations/parentsToChildren'
import { deriveShapeIdsInCurrentPage } from './derivations/shapeIdsInCurrentPage'
import { getSvgJsx } from './getSvgJsx'
import { ClickManager } from './managers/ClickManager'
import { EnvironmentManager } from './managers/EnvironmentManager'
import { HistoryManager } from './managers/HistoryManager'
import { ScribbleManager } from './managers/ScribbleManager'
import { SideEffectManager } from './managers/SideEffectManager'
import { SnapManager } from './managers/SnapManager/SnapManager'
import { TextManager } from './managers/TextManager'
import { TickManager } from './managers/TickManager'
import { UserPreferencesManager } from './managers/UserPreferencesManager'
import { ShapeUtil, TLResizeMode, TLShapeUtilConstructor } from './shapes/ShapeUtil'
import { TLArrowInfo } from './shapes/shared/arrow/arrow-types'
import { getCurvedArrowInfo } from './shapes/shared/arrow/curved-arrow'
import { getArrowTerminalsInArrowSpace, getIsArrowStraight } from './shapes/shared/arrow/shared'
import { getStraightArrowInfo } from './shapes/shared/arrow/straight-arrow'
import { RootState } from './tools/RootState'
import { StateNode, TLStateNodeConstructor } from './tools/StateNode'
import { TLContent } from './types/clipboard-types'
import { TLEventMap } from './types/emit-types'
import {
	TLEventInfo,
	TLPinchEventInfo,
	TLPointerEventInfo,
	TLWheelEventInfo,
} from './types/event-types'
import { TLExternalAssetContent, TLExternalContent } from './types/external-content'
import { TLHistoryBatchOptions } from './types/history-types'
import { EditorResult, OptionalKeys, RequiredKeys, TLSvgOptions } from './types/misc-types'
import { TLResizeHandle } from './types/selection-types'

/** @public */
export type TLAnimationOptions = Partial<{
	duration: number
	easing: (t: number) => number
}>

/** @public */
export type TLResizeShapeOptions = Partial<{
	initialBounds: Box
	scaleOrigin: VecLike
	scaleAxisRotation: number
	initialShape: TLShape
	initialPageTransform: MatLike
	dragHandle: TLResizeHandle
	mode: TLResizeMode
}>

/** @public */
export interface TLEditorOptions {
	/**
	 * The Store instance to use for keeping the app's data. This may be prepopulated, e.g. by loading
	 * from a server or database.
	 */
	store: TLStore
	/**
	 * An array of shapes to use in the editor. These will be used to create and manage shapes in the editor.
	 */
	shapeUtils: readonly TLShapeUtilConstructor<TLUnknownShape>[]
	/**
	 * An array of tools to use in the editor. These will be used to handle events and manage user interactions in the editor.
	 */
	tools: readonly TLStateNodeConstructor[]
	/**
	 * Should return a containing html element which has all the styles applied to the editor. If not
	 * given, the body element will be used.
	 */
	getContainer: () => HTMLElement
	/**
	 * A user defined externally to replace the default user.
	 */
	user?: TLUser
	/**
	 * The editor's initial active tool (or other state node id).
	 */
	initialState?: string
	/**
	 * Whether to infer dark mode from the user's system preferences. Defaults to false.
	 */
	inferDarkMode?: boolean
}

/** @public */
export class Editor extends EventEmitter<TLEventMap> {
	constructor({
		store,
		user,
		shapeUtils,
		tools,
		getContainer,
		initialState,
		inferDarkMode,
	}: TLEditorOptions) {
		super()

		this.store = store
		this.history = new HistoryManager<TLRecord>({
			store,
			annotateError: (error) => {
				this.annotateError(error, { origin: 'history.batch', willCrashApp: true })
				this.crash(error)
			},
		})

		this.snaps = new SnapManager(this)

		this.user = new UserPreferencesManager(user ?? createTLUser(), inferDarkMode ?? false)

		this.getContainer = getContainer ?? (() => document.body)

		this.textMeasure = new TextManager(this)
		this._tickManager = new TickManager(this)

		class NewRoot extends RootState {
			static override initial = initialState ?? ''
		}

		this.root = new NewRoot(this)
		this.root.children = {}

		const allShapeUtils = checkShapesAndAddCore(shapeUtils)

		const _shapeUtils = {} as Record<string, ShapeUtil<any>>
		const _styleProps = {} as Record<string, Map<StyleProp<unknown>, string>>
		const allStylesById = new Map<string, StyleProp<unknown>>()

		for (const Util of allShapeUtils) {
			const util = new Util(this)
			_shapeUtils[Util.type] = util

			const propKeysByStyle = getShapePropKeysByStyle(Util.props ?? {})
			_styleProps[Util.type] = propKeysByStyle

			for (const style of propKeysByStyle.keys()) {
				if (!allStylesById.has(style.id)) {
					allStylesById.set(style.id, style)
				} else if (allStylesById.get(style.id) !== style) {
					throw Error(
						`Multiple style props with id "${style.id}" in use. Style prop IDs must be unique.`
					)
				}
			}
		}

		this.shapeUtils = _shapeUtils
		this.styleProps = _styleProps

		// Tools.
		// Accept tools from constructor parameters which may not conflict with the root note's default or
		// "baked in" tools, select and zoom.
		for (const Tool of [...tools]) {
			if (hasOwnProperty(this.root.children!, Tool.id)) {
				throw Error(`Can't override tool with id "${Tool.id}"`)
			}
			this.root.children![Tool.id] = new Tool(this, this.root)
		}

		this.environment = new EnvironmentManager(this)
		this.scribbles = new ScribbleManager(this)

		// Cleanup

		const invalidParents = new Set<TLShapeId>()

		const reparentArrow = (arrowId: TLArrowShape['id']) => {
			const arrow = this.getShape<TLArrowShape>(arrowId)
			if (!arrow) return
			const { start, end } = arrow.props
			const startShape = start.type === 'binding' ? this.getShape(start.boundShapeId) : undefined
			const endShape = end.type === 'binding' ? this.getShape(end.boundShapeId) : undefined

			const parentPageId = this.getAncestorPageId(arrow)
			if (!parentPageId) return

			let nextParentId: TLParentId
			if (startShape && endShape) {
				// if arrow has two bindings, always parent arrow to closest common ancestor of the bindings
				nextParentId = this.findCommonAncestor([startShape, endShape]) ?? parentPageId
			} else if (startShape || endShape) {
				const bindingParentId = (startShape || endShape)?.parentId
				// If the arrow and the shape that it is bound to have the same parent, then keep that parent
				if (bindingParentId && bindingParentId === arrow.parentId) {
					nextParentId = arrow.parentId
				} else {
					// if arrow has one binding, keep arrow on its own page
					nextParentId = parentPageId
				}
			} else {
				return
			}

			if (nextParentId && nextParentId !== arrow.parentId) {
				this.reparentShapes([arrowId], nextParentId)
			}

			const reparentedArrow = this.getShape<TLArrowShape>(arrowId)
			if (!reparentedArrow) throw Error('no reparented arrow')

			const startSibling = this.getShapeNearestSibling(reparentedArrow, startShape)
			const endSibling = this.getShapeNearestSibling(reparentedArrow, endShape)

			let highestSibling: TLShape | undefined

			if (startSibling && endSibling) {
				highestSibling = startSibling.index > endSibling.index ? startSibling : endSibling
			} else if (startSibling && !endSibling) {
				highestSibling = startSibling
			} else if (endSibling && !startSibling) {
				highestSibling = endSibling
			} else {
				return
			}

			let finalIndex: IndexKey

			const higherSiblings = this.getSortedChildIdsForParent(highestSibling.parentId)
				.map((id) => this.getShape(id)!)
				.filter((sibling) => sibling.index > highestSibling!.index)

			if (higherSiblings.length) {
				// there are siblings above the highest bound sibling, we need to
				// insert between them.

				// if the next sibling is also a bound arrow though, we can end up
				// all fighting for the same indexes. so lets find the next
				// non-arrow sibling...
				const nextHighestNonArrowSibling = higherSiblings.find(
					(sibling) => sibling.type !== 'arrow'
				)

				if (
					// ...then, if we're above the last shape we want to be above...
					reparentedArrow.index > highestSibling.index &&
					// ...but below the next non-arrow sibling...
					(!nextHighestNonArrowSibling || reparentedArrow.index < nextHighestNonArrowSibling.index)
				) {
					// ...then we're already in the right place. no need to update!
					return
				}

				// otherwise, we need to find the index between the highest sibling
				// we want to be above, and the next highest sibling we want to be
				// below:
				finalIndex = getIndexBetween(highestSibling.index, higherSiblings[0].index)
			} else {
				// if there are no siblings above us, we can just get the next index:
				finalIndex = getIndexAbove(highestSibling.index)
			}

			if (finalIndex !== reparentedArrow.index) {
				this.updateShapes<TLArrowShape>([{ id: arrowId, type: 'arrow', index: finalIndex }])
			}
		}

		const unbindArrowTerminal = (arrow: TLArrowShape, handleId: 'start' | 'end') => {
			const { x, y } = getArrowTerminalsInArrowSpace(this, arrow)[handleId]
			this.store.put([{ ...arrow, props: { ...arrow.props, [handleId]: { type: 'point', x, y } } }])
		}

		const arrowDidUpdate = (arrow: TLArrowShape) => {
			// if the shape is an arrow and its bound shape is on another page
			// or was deleted, unbind it
			for (const handle of ['start', 'end'] as const) {
				const terminal = arrow.props[handle]
				if (terminal.type !== 'binding') continue
				const boundShape = this.getShape(terminal.boundShapeId)
				const isShapeInSamePageAsArrow =
					this.getAncestorPageId(arrow) === this.getAncestorPageId(boundShape)
				if (!boundShape || !isShapeInSamePageAsArrow) {
					unbindArrowTerminal(arrow, handle)
				}
			}

			// always check the arrow parents
			reparentArrow(arrow.id)
		}

		const cleanupInstancePageState = (
			prevPageState: TLInstancePageState,
			shapesNoLongerInPage: Set<TLShapeId>
		) => {
			let nextPageState = null as null | TLInstancePageState

			const selectedShapeIds = prevPageState.selectedShapeIds.filter(
				(id) => !shapesNoLongerInPage.has(id)
			)
			if (selectedShapeIds.length !== prevPageState.selectedShapeIds.length) {
				if (!nextPageState) nextPageState = { ...prevPageState }
				nextPageState.selectedShapeIds = selectedShapeIds
			}

			const erasingShapeIds = prevPageState.erasingShapeIds.filter(
				(id) => !shapesNoLongerInPage.has(id)
			)
			if (erasingShapeIds.length !== prevPageState.erasingShapeIds.length) {
				if (!nextPageState) nextPageState = { ...prevPageState }
				nextPageState.erasingShapeIds = erasingShapeIds
			}

			if (prevPageState.hoveredShapeId && shapesNoLongerInPage.has(prevPageState.hoveredShapeId)) {
				if (!nextPageState) nextPageState = { ...prevPageState }
				nextPageState.hoveredShapeId = null
			}

			if (prevPageState.editingShapeId && shapesNoLongerInPage.has(prevPageState.editingShapeId)) {
				if (!nextPageState) nextPageState = { ...prevPageState }
				nextPageState.editingShapeId = null
			}

			const hintingShapeIds = prevPageState.hintingShapeIds.filter(
				(id) => !shapesNoLongerInPage.has(id)
			)
			if (hintingShapeIds.length !== prevPageState.hintingShapeIds.length) {
				if (!nextPageState) nextPageState = { ...prevPageState }
				nextPageState.hintingShapeIds = hintingShapeIds
			}

			if (prevPageState.focusedGroupId && shapesNoLongerInPage.has(prevPageState.focusedGroupId)) {
				if (!nextPageState) nextPageState = { ...prevPageState }
				nextPageState.focusedGroupId = null
			}
			return nextPageState
		}

		this.sideEffects = new SideEffectManager(this)

		this.disposables.add(
			this.sideEffects.registerBatchCompleteHandler(() => {
				for (const parentId of invalidParents) {
					invalidParents.delete(parentId)
					const parent = this.getShape(parentId)
					if (!parent) continue

					const util = this.getShapeUtil(parent)
					const changes = util.onChildrenChange?.(parent)

					if (changes?.length) {
						this.updateShapes(changes)
					}
				}

				this.emit('update')
			})
		)

		this.disposables.add(
			this.sideEffects.register({
				shape: {
					afterCreate: (record) => {
						if (this.isShapeOfType<TLArrowShape>(record, 'arrow')) {
							arrowDidUpdate(record)
						}
					},
					afterChange: (prev, next) => {
						if (this.isShapeOfType<TLArrowShape>(next, 'arrow')) {
							arrowDidUpdate(next)
						}

						// if the shape's parent changed and it is bound to an arrow, update the arrow's parent
						if (prev.parentId !== next.parentId) {
							const reparentBoundArrows = (id: TLShapeId) => {
								const boundArrows = this._getArrowBindingsIndex().get()[id]
								if (boundArrows?.length) {
									for (const arrow of boundArrows) {
										reparentArrow(arrow.arrowId)
									}
								}
							}
							reparentBoundArrows(next.id)
							this.visitDescendants(next.id, reparentBoundArrows)
						}

						// if this shape moved to a new page, clean up any previous page's instance state
						if (prev.parentId !== next.parentId && isPageId(next.parentId)) {
							const allMovingIds = new Set([prev.id])
							this.visitDescendants(prev.id, (id) => {
								allMovingIds.add(id)
							})

							for (const instancePageState of this.getPageStates()) {
								if (instancePageState.pageId === next.parentId) continue
								const nextPageState = cleanupInstancePageState(instancePageState, allMovingIds)

								if (nextPageState) {
									this.store.put([nextPageState])
								}
							}
						}

						if (prev.parentId && isShapeId(prev.parentId)) {
							invalidParents.add(prev.parentId)
						}

						if (next.parentId !== prev.parentId && isShapeId(next.parentId)) {
							invalidParents.add(next.parentId)
						}
					},
					beforeDelete: (record) => {
						// if the deleted shape has a parent shape make sure we call it's onChildrenChange callback
						if (record.parentId && isShapeId(record.parentId)) {
							invalidParents.add(record.parentId)
						}
						// clean up any arrows bound to this shape
						const bindings = this._getArrowBindingsIndex().get()[record.id]
						if (bindings?.length) {
							for (const { arrowId, handleId } of bindings) {
								const arrow = this.getShape<TLArrowShape>(arrowId)
								if (!arrow) continue
								unbindArrowTerminal(arrow, handleId)
							}
						}
						const deletedIds = new Set([record.id])
						const updates = compact(
							this.getPageStates().map((pageState) => {
								return cleanupInstancePageState(pageState, deletedIds)
							})
						)

						if (updates.length) {
							this.store.put(updates)
						}
					},
				},
				page: {
					afterCreate: (record) => {
						const cameraId = CameraRecordType.createId(record.id)
						const _pageStateId = InstancePageStateRecordType.createId(record.id)
						if (!this.store.has(cameraId)) {
							this.store.put([CameraRecordType.create({ id: cameraId })])
						}
						if (!this.store.has(_pageStateId)) {
							this.store.put([
								InstancePageStateRecordType.create({ id: _pageStateId, pageId: record.id }),
							])
						}
					},
					afterDelete: (record, source) => {
						// page was deleted, need to check whether it's the current page and select another one if so
						if (this.getInstanceState()?.currentPageId === record.id) {
							const backupPageId = this.getPages().find((p) => p.id !== record.id)?.id
							if (backupPageId) {
								this.store.put([{ ...this.getInstanceState(), currentPageId: backupPageId }])
							} else if (source === 'user') {
								// fall back to ensureStoreIsUsable:
								this.store.ensureStoreIsUsable()
							}
						}

						// delete the camera and state for the page if necessary
						const cameraId = CameraRecordType.createId(record.id)
						const instance_PageStateId = InstancePageStateRecordType.createId(record.id)
						this.store.remove([cameraId, instance_PageStateId])
					},
				},
				instance: {
					afterChange: (prev, next, source) => {
						// instance should never be updated to a page that no longer exists (this can
						// happen when undoing a change that involves switching to a page that has since
						// been deleted by another user)
						if (!this.store.has(next.currentPageId)) {
							const backupPageId = this.store.has(prev.currentPageId)
								? prev.currentPageId
								: this.getPages()[0]?.id
							if (backupPageId) {
								this.store.update(next.id, (instance) => ({
									...instance,
									currentPageId: backupPageId,
								}))
							} else if (source === 'user') {
								// fall back to ensureStoreIsUsable:
								this.store.ensureStoreIsUsable()
							}
						}
					},
				},
				instance_page_state: {
					afterChange: (prev, next) => {
						if (prev?.selectedShapeIds !== next?.selectedShapeIds) {
							// ensure that descendants and ancestors are not selected at the same time
							const filtered = next.selectedShapeIds.filter((id) => {
								let parentId = this.getShape(id)?.parentId
								while (isShapeId(parentId)) {
									if (next.selectedShapeIds.includes(parentId)) {
										return false
									}
									parentId = this.getShape(parentId)?.parentId
								}
								return true
							})

							let nextFocusedGroupId: null | TLShapeId = null

							if (filtered.length > 0) {
								const commonGroupAncestor = this.findCommonAncestor(
									compact(filtered.map((id) => this.getShape(id))),
									(shape) => this.isShapeOfType<TLGroupShape>(shape, 'group')
								)

								if (commonGroupAncestor) {
									nextFocusedGroupId = commonGroupAncestor
								}
							} else {
								if (next?.focusedGroupId) {
									nextFocusedGroupId = next.focusedGroupId
								}
							}

							if (
								filtered.length !== next.selectedShapeIds.length ||
								nextFocusedGroupId !== next.focusedGroupId
							) {
								this.store.put([
									{
										...next,
										selectedShapeIds: filtered,
										focusedGroupId: nextFocusedGroupId ?? null,
									},
								])
							}
						}
					},
				},
			})
		)

		this._currentPageShapeIds = deriveShapeIdsInCurrentPage(this.store, () =>
			this.getCurrentPageId()
		)
		this._parentIdsToChildIds = parentsToChildren(this.store)

		this.disposables.add(
			this.store.listen((changes) => {
				this.emit('change', changes)
			})
		)
		this.disposables.add(this.history.dispose)

		this.history.ignore(() => {
			this.store.ensureStoreIsUsable()

			// clear ephemeral state
			this._updateCurrentPageState({
				editingShapeId: null,
				hoveredShapeId: null,
				erasingShapeIds: [],
			})
		})

		if (initialState && this.root.children[initialState] === undefined) {
			throw Error(`No state found for initialState "${initialState}".`)
		}

		this.root.enter(undefined, 'initial')

		if (this.getInstanceState().followingUserId) {
			this.stopFollowingUser()
		}

		this.updateRenderingBounds()

		this.on('tick', this._flushEventsForTick)

		requestAnimationFrame(() => {
			this._tickManager.start()
		})
	}

	/**
	 * The editor's store
	 *
	 * @public
	 */
	readonly store: TLStore

	/**
	 * The root state of the statechart.
	 *
	 * @public
	 */
	readonly root: RootState

	/**
	 * A set of functions to call when the app is disposed.
	 *
	 * @public
	 */
	readonly disposables = new Set<() => void>()

	/** @internal */
	private readonly _tickManager

	/**
	 * A manager for the app's snapping feature.
	 *
	 * @public
	 */
	readonly snaps: SnapManager

	/**
	 * A manager for the user and their preferences.
	 *
	 * @public
	 */
	readonly user: UserPreferencesManager

	/**
	 * A helper for measuring text.
	 *
	 * @public
	 */
	readonly textMeasure: TextManager

	/**
	 * A manager for the editor's environment.
	 *
	 * @public
	 */
	readonly environment: EnvironmentManager

	/**
	 * A manager for the editor's scribbles.
	 *
	 * @public
	 */
	readonly scribbles: ScribbleManager

	/**
	 * The current HTML element containing the editor.
	 *
	 * @example
	 * ```ts
	 * const container = editor.getContainer()
	 * ```
	 *
	 * @public
	 */
	getContainer: () => HTMLElement

	/**
	 * A manager for side effects and correct state enforcement. See {@link SideEffectManager} for details.
	 *
	 * @public
	 */
	readonly sideEffects: SideEffectManager<this>

	/**
	 * Dispose the editor.
	 *
	 * @public
	 */
	dispose() {
		this.disposables.forEach((dispose) => dispose())
		this.disposables.clear()
	}

	/* ------------------- Shape Utils ------------------ */

	/**
	 * A map of shape utility classes (TLShapeUtils) by shape type.
	 *
	 * @public
	 */
	shapeUtils: { readonly [K in string]?: ShapeUtil<TLUnknownShape> }

	styleProps: { [key: string]: Map<StyleProp<any>, string> }

	/**
	 * Get a shape util from a shape itself.
	 *
	 * @example
	 * ```ts
	 * const util = editor.getShapeUtil(myArrowShape)
	 * const util = editor.getShapeUtil('arrow')
	 * const util = editor.getShapeUtil<TLArrowShape>(myArrowShape)
	 * const util = editor.getShapeUtil(TLArrowShape)('arrow')
	 * ```
	 *
	 * @param shape - A shape, shape partial, or shape type.
	 *
	 * @public
	 */
	getShapeUtil<S extends TLUnknownShape>(shape: S | TLShapePartial<S>): ShapeUtil<S>
	getShapeUtil<S extends TLUnknownShape>(type: S['type']): ShapeUtil<S>
	getShapeUtil<T extends ShapeUtil>(type: T extends ShapeUtil<infer R> ? R['type'] : string): T
	getShapeUtil(arg: string | { type: string }) {
		const type = typeof arg === 'string' ? arg : arg.type
		const shapeUtil = getOwnProperty(this.shapeUtils, type)
		assert(shapeUtil, `No shape util found for type "${type}"`)
		return shapeUtil
	}

	/* --------------------- History -------------------- */

	/**
	 * A manager for the app's history.
	 *
	 * @readonly
	 */
	readonly history: HistoryManager<TLRecord>

	/**
	 * Undo to the last mark.
	 *
	 * @example
	 * ```ts
	 * editor.undo()
	 * ```
	 *
	 * @public
	 */
	undo(): this {
		this._flushEventsForTick(0)
		this.history.undo()
		return this
	}

	/**
	 * Whether the app can undo.
	 *
	 * @public
	 */
	@computed getCanUndo(): boolean {
		return this.history.getNumUndos() > 0
	}

	/**
	 * Redo to the next mark.
	 *
	 * @example
	 * ```ts
	 * editor.redo()
	 * ```
	 *
	 * @public
	 */
	redo(): this {
		this._flushEventsForTick(0)
		this.history.redo()
		return this
	}

	/**
	 * Whether the app can redo.
	 *
	 * @public
	 */
	@computed getCanRedo(): boolean {
		return this.history.getNumRedos() > 0
	}

	/**
	 * Create a new "mark", or stopping point, in the undo redo history. Creating a mark will clear
	 * any redos.
	 *
	 * @example
	 * ```ts
	 * editor.mark()
	 * editor.mark('flip shapes')
	 * ```
	 *
	 * @param markId - The mark's id, usually the reason for adding the mark.
	 *
	 * @public
	 */
	mark(markId?: string): this {
		this.history.mark(markId)
		return this
	}

	/**
	 * Clear all marks in the undo stack back to the next mark.
	 *
	 * @example
	 * ```ts
	 * editor.bail()
	 * ```
	 *
	 * @public
	 */
	bail() {
		this.history.bail()
		return this
	}

	/**
	 * Clear all marks in the undo stack back to the mark with the provided mark id.
	 *
	 * @example
	 * ```ts
	 * editor.bailToMark('dragging')
	 * ```
	 *
	 * @public
	 */
	bailToMark(id: string): this {
		this.history.bailToMark(id)
		return this
	}

	/**
	 * Run a function in a batch.
	 *
	 * @public
	 */
	batch(fn: () => void, opts?: TLHistoryBatchOptions): this {
		this.history.batch(fn, opts)
		return this
	}

	/* --------------------- Arrows --------------------- */
	// todo: move these to tldraw or replace with a bindings API

	/** @internal */
	@computed
	private _getArrowBindingsIndex() {
		return arrowBindingsIndex(this)
	}

	/**
	 * Get all arrows bound to a shape.
	 *
	 * @param shapeId - The id of the shape.
	 *
	 * @public
	 */
	getArrowsBoundTo(shapeId: TLShapeId) {
		return this._getArrowBindingsIndex().get()[shapeId] || EMPTY_ARRAY
	}

	@computed
	private getArrowInfoCache() {
		return this.store.createComputedCache<TLArrowInfo, TLArrowShape>('arrow infoCache', (shape) => {
			return getIsArrowStraight(shape)
				? getStraightArrowInfo(this, shape)
				: getCurvedArrowInfo(this, shape)
		})
	}

	/**
	 * Get cached info about an arrow.
	 *
	 * @example
	 * ```ts
	 * const arrowInfo = editor.getArrowInfo(myArrow)
	 * ```
	 *
	 * @param shape - The shape (or shape id) of the arrow to get the info for.
	 *
	 * @public
	 */
	getArrowInfo(shape: TLArrowShape | TLShapeId): TLArrowInfo | undefined {
		const id = typeof shape === 'string' ? shape : shape.id
		return this.getArrowInfoCache().get(id)
	}

	/* --------------------- Errors --------------------- */

	/** @internal */
	annotateError(
		error: unknown,
		{
			origin,
			willCrashApp,
			tags,
			extras,
		}: {
			origin: string
			willCrashApp: boolean
			tags?: Record<string, string | boolean | number>
			extras?: Record<string, unknown>
		}
	): this {
		const defaultAnnotations = this.createErrorAnnotations(origin, willCrashApp)
		annotateError(error, {
			tags: { ...defaultAnnotations.tags, ...tags },
			extras: { ...defaultAnnotations.extras, ...extras },
		})
		if (willCrashApp) {
			this.store.markAsPossiblyCorrupted()
		}
		return this
	}

	/** @internal */
	createErrorAnnotations(
		origin: string,
		willCrashApp: boolean | 'unknown'
	): {
		tags: { origin: string; willCrashApp: boolean | 'unknown' }
		extras: {
			activeStateNode?: string
			selectedShapes?: TLUnknownShape[]
			editingShape?: TLUnknownShape
			inputs?: Record<string, unknown>
		}
	} {
		try {
			const editingShapeId = this.getEditingShapeId()
			return {
				tags: {
					origin: origin,
					willCrashApp,
				},
				extras: {
					activeStateNode: this.root.getPath(),
					selectedShapes: this.getSelectedShapes(),
					editingShape: editingShapeId ? this.getShape(editingShapeId) : undefined,
					inputs: this.inputs,
				},
			}
		} catch {
			return {
				tags: {
					origin: origin,
					willCrashApp,
				},
				extras: {},
			}
		}
	}

	/** @internal */
	private _crashingError: unknown | null = null

	/**
	 * We can't use an `atom` here because there's a chance that when `crashAndReportError` is called,
	 * we're in a transaction that's about to be rolled back due to the same error we're currently
	 * reporting.
	 *
	 * Instead, to listen to changes to this value, you need to listen to app's `crash` event.
	 *
	 * @internal
	 */
	getCrashingError() {
		return this._crashingError
	}

	/** @internal */
	crash(error: unknown): this {
		this._crashingError = error
		this.store.markAsPossiblyCorrupted()
		this.emit('crash', { error })
		return this
	}

	/* ------------------- Statechart ------------------- */

	/**
	 * The editor's current path of active states.
	 *
	 * @example
	 * ```ts
	 * editor.getPath() // "select.idle"
	 * ```
	 *
	 * @public
	 */
	@computed getPath() {
		return this.root.getPath().split('root.')[1]
	}

	/**
	 * Get whether a certain tool (or other state node) is currently active.
	 *
	 * @example
	 * ```ts
	 * editor.isIn('select')
	 * editor.isIn('select.brushing')
	 * ```
	 *
	 * @param path - The path of active states, separated by periods.
	 *
	 * @public
	 */
	isIn(path: string): boolean {
		const ids = path.split('.').reverse()
		let state = this.root as StateNode
		while (ids.length > 0) {
			const id = ids.pop()
			if (!id) return true
			const current = state.getCurrent()
			if (current?.id === id) {
				if (ids.length === 0) return true
				state = current
				continue
			} else return false
		}
		return false
	}

	/**
	 * Get whether the state node is in any of the given active paths.
	 *
	 * @example
	 * ```ts
	 * state.isInAny('select', 'erase')
	 * state.isInAny('select.brushing', 'erase.idle')
	 * ```
	 *
	 * @public
	 */
	isInAny(...paths: string[]): boolean {
		return paths.some((path) => this.isIn(path))
	}

	/**
	 * Set the selected tool.
	 *
	 * @example
	 * ```ts
	 * editor.setCurrentTool('hand')
	 * editor.setCurrentTool('hand', { date: Date.now() })
	 * ```
	 *
	 * @param id - The id of the tool to select.
	 * @param info - Arbitrary data to pass along into the transition.
	 *
	 * @public
	 */
	setCurrentTool(id: string, info = {}): this {
		this.root.transition(id, info)
		return this
	}

	/**
	 * The current selected tool.
	 *
	 * @public
	 */
	@computed getCurrentTool(): StateNode {
		return this.root.getCurrent()!
	}

	/**
	 * The id of the current selected tool.
	 *
	 * @public
	 */
	@computed getCurrentToolId(): string {
		const currentTool = this.getCurrentTool()
		if (!currentTool) return ''
		return currentTool.getCurrentToolIdMask() ?? currentTool.id
	}

	/**
	 * Get a descendant by its path.
	 *
	 * @example
	 * ```ts
	 * state.getStateDescendant('select')
	 * state.getStateDescendant('select.brushing')
	 * ```
	 *
	 * @param path - The descendant's path of state ids, separated by periods.
	 *
	 * @public
	 */
	getStateDescendant<T extends StateNode>(path: string): T | undefined {
		const ids = path.split('.').reverse()
		let state = this.root as StateNode
		while (ids.length > 0) {
			const id = ids.pop()
			if (!id) return state as T
			const childState = state.children?.[id]
			if (!childState) return undefined
			state = childState
		}
		return state as T
	}

	/* ---------------- Document Settings --------------- */

	/**
	 * The global document settings that apply to all users.
	 *
	 * @public
	 **/
	@computed getDocumentSettings() {
		return this.store.get(TLDOCUMENT_ID)!
	}

	/**
	 * Update the global document settings that apply to all users.
	 *
	 * @public
	 **/
	updateDocumentSettings(settings: Partial<TLDocument>): this {
		this.history.ignore(() => {
			this.store.put([{ ...this.getDocumentSettings(), ...settings }])
		})
		return this
	}

	/* ----------------- Instance State ----------------- */

	/**
	 * The current instance's state.
	 *
	 * @public
	 */
	@computed getInstanceState(): TLInstance {
		return this.store.get(TLINSTANCE_ID)!
	}

	/**
	 * Update the instance's state.
	 *
	 * @param partial - A partial object to update the instance state with.
	 *
	 * @public
	 */
	updateInstanceState(
		partial: Partial<Omit<TLInstance, 'currentPageId'>>,
		historyOptions?: TLHistoryBatchOptions
	): this {
		this._updateInstanceState(partial, { history: 'ignore', ...historyOptions })

		if (partial.isChangingStyle !== undefined) {
			clearTimeout(this._isChangingStyleTimeout)
			if (partial.isChangingStyle === true) {
				// If we've set to true, set a new reset timeout to change the value back to false after 2 seconds
				this._isChangingStyleTimeout = setTimeout(() => {
					this._updateInstanceState({ isChangingStyle: false }, { history: 'ignore' })
				}, 2000)
			}
		}

		return this
	}

	/** @internal */
	private _updateInstanceState = (
		partial: Partial<Omit<TLInstance, 'currentPageId'>>,
		opts?: TLHistoryBatchOptions
	) => {
		this.batch(() => {
			this.store.put([
				{
					...this.getInstanceState(),
					...partial,
				},
			])
		}, opts)
	}

	/** @internal */
	private _isChangingStyleTimeout = -1 as any

	// Menus

	/**
	 * A set of strings representing any open menus. When menus are open,
	 * certain interactions will behave differently; for example, when a
	 * draw tool is selected and a menu is open, a pointer-down will not
	 * create a dot (because the user is probably trying to close the menu)
	 * however a pointer-down event followed by a drag will begin drawing
	 * a line (because the user is BOTH trying to close the menu AND start
	 * drawing a line).
	 *
	 * @public
	 */
	@computed getOpenMenus(): string[] {
		return this.getInstanceState().openMenus
	}

	/**
	 * Add an open menu.
	 *
	 * @example
	 * ```ts
	 * editor.addOpenMenu('menu-id')
	 * ```
	 *
	 * @public
	 */
	addOpenMenu(id: string): this {
		const menus = new Set(this.getOpenMenus())
		if (!menus.has(id)) {
			menus.add(id)
			this.updateInstanceState({ openMenus: [...menus] })
		}
		return this
	}

	/**
	 * Delete an open menu.
	 *
	 * @example
	 * ```ts
	 * editor.deleteOpenMenu('menu-id')
	 * ```
	 *
	 * @public
	 */
	deleteOpenMenu(id: string): this {
		const menus = new Set(this.getOpenMenus())
		if (menus.has(id)) {
			menus.delete(id)
			this.updateInstanceState({ openMenus: [...menus] })
		}
		return this
	}

	/**
	 * Clear all open menus.
	 *
	 * @example
	 * ```ts
	 * editor.clearOpenMenus()
	 * ```
	 *
	 * @public
	 */
	clearOpenMenus(): this {
		if (this.getOpenMenus().length) {
			this.updateInstanceState({ openMenus: [] })
		}
		return this
	}

	/**
	 * Get whether any menus are open.
	 *
	 * @example
	 * ```ts
	 * editor.getIsMenuOpen()
	 * ```
	 *
	 * @public
	 */
	@computed getIsMenuOpen(): boolean {
		return this.getOpenMenus().length > 0
	}

	/* --------------------- Cursor --------------------- */

	/**
	 * Set the cursor.
	 *
	 * @param type - The cursor type.
	 * @param rotation - The cursor rotation.
	 *
	 * @public
	 */
	setCursor = (cursor: Partial<TLCursor>): this => {
		this.updateInstanceState({ cursor: { ...this.getInstanceState().cursor, ...cursor } })
		return this
	}

	/* ------------------- Page State ------------------- */

	/**
	 * Page states.
	 *
	 * @public
	 */
	@computed getPageStates(): TLInstancePageState[] {
		return this._getPageStatesQuery().get()
	}

	/** @internal */
	@computed private _getPageStatesQuery() {
		return this.store.query.records('instance_page_state')
	}

	/**
	 * The current page state.
	 *
	 * @public
	 */
	@computed getCurrentPageState(): TLInstancePageState {
		return this.store.get(this._getCurrentPageStateId())!
	}

	/** @internal */
	@computed private _getCurrentPageStateId() {
		return InstancePageStateRecordType.createId(this.getCurrentPageId())
	}

	/**
	 * Update this instance's page state.
	 *
	 * @example
	 * ```ts
	 * editor.updateCurrentPageState({ id: 'page1', editingShapeId: 'shape:123' })
	 * editor.updateCurrentPageState({ id: 'page1', editingShapeId: 'shape:123' }, { ephemeral: true })
	 * ```
	 *
	 * @param partial - The partial of the page state object containing the changes.
	 * @param historyOptions - The history options for the change.
	 *
	 * @public
	 */
	updateCurrentPageState(
		partial: Partial<
			Omit<TLInstancePageState, 'selectedShapeIds' | 'editingShapeId' | 'pageId' | 'focusedGroupId'>
		>,
		historyOptions?: TLHistoryBatchOptions
	): this {
		this._updateCurrentPageState(partial, historyOptions)
		return this
	}
	_updateCurrentPageState = (
		partial: Partial<Omit<TLInstancePageState, 'selectedShapeIds'>>,
		historyOptions?: TLHistoryBatchOptions
	) => {
		this.batch(() => {
			this.store.update(partial.id ?? this.getCurrentPageState().id, (state) => ({
				...state,
				...partial,
			}))
		}, historyOptions)
	}

	/**
	 * The current selected ids.
	 *
	 * @public
	 */
	@computed getSelectedShapeIds() {
		return this.getCurrentPageState().selectedShapeIds
	}

	/**
	 * An array containing all of the currently selected shapes.
	 *
	 * @public
	 * @readonly
	 */
	@computed getSelectedShapes(): TLShape[] {
		const { selectedShapeIds } = this.getCurrentPageState()
		return compact(selectedShapeIds.map((id) => this.store.get(id)))
	}

	/**
	 * Select one or more shapes.
	 *
	 * @example
	 * ```ts
	 * editor.setSelectedShapes(['id1'])
	 * editor.setSelectedShapes(['id1', 'id2'])
	 * ```
	 *
	 * @param ids - The ids to select.
	 *
	 * @public
	 */
	setSelectedShapes(shapes: TLShapeId[] | TLShape[]): this {
		return this.batch(() => {
			const ids = shapes.map((shape) => (typeof shape === 'string' ? shape : shape.id))
			const { selectedShapeIds: prevSelectedShapeIds } = this.getCurrentPageState()
			const prevSet = new Set(prevSelectedShapeIds)

			if (ids.length === prevSet.size && ids.every((id) => prevSet.has(id))) return null

			this.store.put([{ ...this.getCurrentPageState(), selectedShapeIds: ids }])
		})
	}

	/**
	 * Determine whether or not any of a shape's ancestors are selected.
	 *
	 * @param id - The id of the shape to check.
	 *
	 * @public
	 */
	isAncestorSelected(shape: TLShape | TLShapeId): boolean {
		const id = typeof shape === 'string' ? shape : shape?.id ?? null
		const _shape = this.getShape(id)
		if (!_shape) return false
		const selectedShapeIds = this.getSelectedShapeIds()
		return !!this.findShapeAncestor(_shape, (parent) => selectedShapeIds.includes(parent.id))
	}

	/**
	 * Select one or more shapes.
	 *
	 * @example
	 * ```ts
	 * editor.select('id1')
	 * editor.select('id1', 'id2')
	 * ```
	 *
	 * @param ids - The ids to select.
	 *
	 * @public
	 */
	select(...shapes: TLShapeId[] | TLShape[]): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((shape) => shape.id)
		this.setSelectedShapes(ids)
		return this
	}

	/**
	 * Remove a shape from the existing set of selected shapes.
	 *
	 * @example
	 * ```ts
	 * editor.deselect(shape.id)
	 * ```
	 *
	 * @public
	 */
	deselect(...shapes: TLShapeId[] | TLShape[]): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((shape) => shape.id)
		const selectedShapeIds = this.getSelectedShapeIds()
		if (selectedShapeIds.length > 0 && ids.length > 0) {
			this.setSelectedShapes(selectedShapeIds.filter((id) => !ids.includes(id)))
		}
		return this
	}

	/**
	 * Select all direct children of the current page.
	 *
	 * @example
	 * ```ts
	 * editor.selectAll()
	 * ```
	 *
	 * @public
	 */
	selectAll(): this {
		const ids = this.getSortedChildIdsForParent(this.getCurrentPageId())
		// page might have no shapes
		if (ids.length <= 0) return this
		this.setSelectedShapes(this._getUnlockedShapeIds(ids))

		return this
	}

	/**
	 * Clear the selection.
	 *
	 * @example
	 * ```ts
	 * editor.selectNone()
	 * ```
	 *
	 * @public
	 */
	selectNone(): this {
		if (this.getSelectedShapeIds().length > 0) {
			this.setSelectedShapes([])
		}

		return this
	}

	/**
	 * The id of the app's only selected shape.
	 *
	 * @returns Null if there is no shape or more than one selected shape, otherwise the selected shape's id.
	 *
	 * @public
	 * @readonly
	 */
	@computed getOnlySelectedShapeId(): TLShapeId | null {
		return this.getOnlySelectedShape()?.id ?? null
	}

	/**
	 * The app's only selected shape.
	 *
	 * @returns Null if there is no shape or more than one selected shape, otherwise the selected shape.
	 *
	 * @public
	 * @readonly
	 */
	@computed getOnlySelectedShape(): TLShape | null {
		const selectedShapes = this.getSelectedShapes()
		return selectedShapes.length === 1 ? selectedShapes[0] : null
	}

	/**
	 * The current page bounds of all the selected shapes. If the
	 * selection is rotated, then these bounds are the axis-aligned
	 * box that the rotated bounds would fit inside of.
	 *
	 * @readonly
	 *
	 * @public
	 */
	@computed getSelectionPageBounds(): Box | null {
		const selectedShapeIds = this.getCurrentPageState().selectedShapeIds
		if (selectedShapeIds.length === 0) return null

		return Box.Common(compact(selectedShapeIds.map((id) => this.getShapePageBounds(id))))
	}

	/**
	 * The rotation of the selection bounding box in the current page space.
	 *
	 * @readonly
	 * @public
	 */
	@computed getSelectionRotation(): number {
		const selectedShapeIds = this.getSelectedShapeIds()
		let foundFirst = false // annoying but we can't use an i===0 check because we need to skip over undefineds
		let rotation = 0
		for (let i = 0, n = selectedShapeIds.length; i < n; i++) {
			const pageTransform = this.getShapePageTransform(selectedShapeIds[i])
			if (!pageTransform) continue
			if (foundFirst) {
				if (pageTransform.rotation() !== rotation) {
					// There are at least 2 different rotations, so the common rotation is zero
					return 0
				}
			} else {
				// First rotation found
				foundFirst = true
				rotation = pageTransform.rotation()
			}
		}

		return rotation
	}

	/**
	 * The bounds of the selection bounding box in the current page space.
	 *
	 * @readonly
	 * @public
	 */
	@computed getSelectionRotatedPageBounds(): Box | undefined {
		const selectedShapeIds = this.getSelectedShapeIds()

		if (selectedShapeIds.length === 0) {
			return undefined
		}

		const selectionRotation = this.getSelectionRotation()
		if (selectionRotation === 0) {
			return this.getSelectionPageBounds()!
		}

		if (selectedShapeIds.length === 1) {
			const bounds = this.getShapeGeometry(selectedShapeIds[0]).bounds.clone()
			const pageTransform = this.getShapePageTransform(selectedShapeIds[0])!
			bounds.point = pageTransform.applyToPoint(bounds.point)
			return bounds
		}

		// need to 'un-rotate' all the outlines of the existing nodes so we can fit them inside a box
		const boxFromRotatedVertices = Box.FromPoints(
			this.getSelectedShapeIds()
				.flatMap((id) => {
					const pageTransform = this.getShapePageTransform(id)
					if (!pageTransform) return []
					return pageTransform.applyToPoints(this.getShapeGeometry(id).bounds.corners)
				})
				.map((p) => p.rot(-selectionRotation))
		)
		// now position box so that it's top-left corner is in the right place
		boxFromRotatedVertices.point = boxFromRotatedVertices.point.rot(selectionRotation)
		return boxFromRotatedVertices
	}

	/**
	 * The bounds of the selection bounding box in the current page space.
	 *
	 * @readonly
	 * @public
	 */
	@computed getSelectionRotatedScreenBounds(): Box | undefined {
		const bounds = this.getSelectionRotatedPageBounds()
		if (!bounds) return undefined
		const { x, y } = this.pageToScreen(bounds.point)
		const zoom = this.getZoomLevel()
		return new Box(x, y, bounds.width * zoom, bounds.height * zoom)
	}

	// Focus Group

	/**
	 * The current focused group id.
	 *
	 * @public
	 */
	@computed getFocusedGroupId(): TLShapeId | TLPageId {
		return this.getCurrentPageState().focusedGroupId ?? this.getCurrentPageId()
	}

	/**
	 * The current focused group.
	 *
	 * @public
	 */
	@computed getFocusedGroup(): TLShape | undefined {
		const focusedGroupId = this.getFocusedGroupId()
		return focusedGroupId ? this.getShape(focusedGroupId) : undefined
	}

	/**
	 * Set the current focused group shape.
	 *
	 * @param shape - The group shape id (or group shape's id) to set as the focused group shape.
	 *
	 * @public
	 */
	setFocusedGroup(shape: TLShapeId | TLGroupShape | null): this {
		const id = typeof shape === 'string' ? shape : shape?.id ?? null

		if (id !== null) {
			const shape = this.getShape(id)
			if (!shape) {
				throw Error(`Editor.setFocusedGroup: Shape with id ${id} does not exist`)
			}

			if (!this.isShapeOfType<TLGroupShape>(shape, 'group')) {
				throw Error(
					`Editor.setFocusedGroup: Cannot set focused group to shape of type ${shape.type}`
				)
			}
		}

		if (id === this.getFocusedGroupId()) return this

		return this.batch(
			() => {
				this.store.update(this.getCurrentPageState().id, (s) => ({ ...s, focusedGroupId: id }))
			},
			{ history: 'record-preserveRedoStack' }
		)
	}

	/**
	 * Exit the current focused group, moving up to the next parent group if there is one.
	 *
	 * @public
	 */
	popFocusedGroupId(): this {
		const focusedGroup = this.getFocusedGroup()

		if (focusedGroup) {
			// If we have a focused layer, look for an ancestor of the focused shape that is a group
			const match = this.findShapeAncestor(focusedGroup, (shape) =>
				this.isShapeOfType<TLGroupShape>(shape, 'group')
			)
			// If we have an ancestor that can become a focused layer, set it as the focused layer
			this.setFocusedGroup(match?.id ?? null)
			this.select(focusedGroup.id)
		} else {
			// If there's no parent focused group, then clear the focus layer and clear selection
			this.setFocusedGroup(null)
			this.selectNone()
		}

		return this
	}

	/**
	 * The current editing shape's id.
	 *
	 * @public
	 */
	@computed getEditingShapeId(): TLShapeId | null {
		return this.getCurrentPageState().editingShapeId
	}

	/**
	 * The current editing shape.
	 *
	 * @public
	 */
	@computed getEditingShape(): TLShape | undefined {
		const editingShapeId = this.getEditingShapeId()
		return editingShapeId ? this.getShape(editingShapeId) : undefined
	}

	/**
	 * Set the current editing shape.
	 *
	 * @example
	 * ```ts
	 * editor.setEditingShape(myShape)
	 * editor.setEditingShape(myShape.id)
	 * ```
	 *
	 * @param shape - The shape (or shape id) to set as editing.
	 *
	 * @public
	 */
	setEditingShape(shape: TLShapeId | TLShape | null): this {
		const id = typeof shape === 'string' ? shape : shape?.id ?? null
		if (id !== this.getEditingShapeId()) {
			if (id) {
				const shape = this.getShape(id)
				if (shape && this.getShapeUtil(shape).canEdit(shape)) {
					this._updateCurrentPageState({ editingShapeId: id })
					return this
				}
			}

			// Either we just set the editing id to null, or the shape was missing or not editable
			this._updateCurrentPageState({ editingShapeId: null })
		}
		return this
	}

	// Hovered

	/**
	 * The current hovered shape id.
	 *
	 * @readonly
	 * @public
	 */
	@computed getHoveredShapeId(): TLShapeId | null {
		return this.getCurrentPageState().hoveredShapeId
	}

	/**
	 * The current hovered shape.
	 *
	 * @public
	 */
	@computed getHoveredShape(): TLShape | undefined {
		const hoveredShapeId = this.getHoveredShapeId()
		return hoveredShapeId ? this.getShape(hoveredShapeId) : undefined
	}
	/**
	 * Set the editor's current hovered shape.
	 *
	 * @example
	 * ```ts
	 * editor.setHoveredShape(myShape)
	 * editor.setHoveredShape(myShape.id)
	 * ```
	 *
	 * @param shapes - The shape (or shape id) to set as hovered.
	 *
	 * @public
	 */
	setHoveredShape(shape: TLShapeId | TLShape | null): this {
		const id = typeof shape === 'string' ? shape : shape?.id ?? null
		if (id === this.getHoveredShapeId()) return this
		this.updateCurrentPageState({ hoveredShapeId: id })
		return this
	}

	// Hinting

	/**
	 * The editor's current hinting shape ids.
	 *
	 * @public
	 */
	@computed getHintingShapeIds() {
		return this.getCurrentPageState().hintingShapeIds
	}
	/**
	 * The editor's current hinting shapes.
	 *
	 * @public
	 */
	@computed getHintingShape() {
		const hintingShapeIds = this.getHintingShapeIds()
		return compact(hintingShapeIds.map((id) => this.getShape(id)))
	}

	/**
	 * Set the editor's current hinting shapes.
	 *
	 * @example
	 * ```ts
	 * editor.setHintingShapes([myShape])
	 * editor.setHintingShapes([myShape.id])
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) to set as hinting.
	 *
	 * @public
	 */
	setHintingShapes(shapes: TLShapeId[] | TLShape[]): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((shape) => shape.id)
		// always ephemeral
		this.updateCurrentPageState({ hintingShapeIds: dedupe(ids) }, { history: 'ignore' })
		return this
	}

	// Erasing

	/**
	 * The editor's current erasing ids.
	 *
	 * @public
	 */
	@computed getErasingShapeIds() {
		return this.getCurrentPageState().erasingShapeIds
	}

	/**
	 * The editor's current erasing shapes.
	 *
	 * @public
	 */
	@computed getErasingShapes() {
		const erasingShapeIds = this.getErasingShapeIds()
		return compact(erasingShapeIds.map((id) => this.getShape(id)))
	}

	/**
	 * Set the editor's current erasing shapes.
	 *
	 * @example
	 * ```ts
	 * editor.setErasingShapes([myShape])
	 * editor.setErasingShapes([myShape.id])
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) to set as hinting.
	 *
	 * @public
	 */
	setErasingShapes(shapes: TLShapeId[] | TLShape[]): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((shape) => shape.id)
		ids.sort() // sort the incoming ids
		const erasingShapeIds = this.getErasingShapeIds()
		this.history.ignore(() => {
			if (ids.length === erasingShapeIds.length) {
				// if the new ids are the same length as the current ids, they might be the same.
				// presuming the current ids are also sorted, check each item to see if it's the same;
				// if we find any unequal, then we know the new ids are different.
				for (let i = 0; i < ids.length; i++) {
					if (ids[i] !== erasingShapeIds[i]) {
						this._updateCurrentPageState({ erasingShapeIds: ids })
						break
					}
				}
			} else {
				// if the ids are a different length, then we know they're different.
				this._updateCurrentPageState({ erasingShapeIds: ids })
			}
		})

		return this
	}

	// Cropping

	/**
	 * The current cropping shape's id.
	 *
	 * @public
	 */
	getCroppingShapeId() {
		return this.getCurrentPageState().croppingShapeId
	}

	/**
	 * Set the current cropping shape.
	 *
	 * @example
	 * ```ts
	 * editor.setCroppingShape(myShape)
	 * editor.setCroppingShape(myShape.id)
	 * ```
	 *
	 *
	 * @param shape - The shape (or shape id) to set as cropping.
	 *
	 * @public
	 */
	setCroppingShape(shape: TLShapeId | TLShape | null): this {
		const id = typeof shape === 'string' ? shape : shape?.id ?? null
		if (id !== this.getCroppingShapeId()) {
			if (!id) {
				this.updateCurrentPageState({ croppingShapeId: null })
			} else {
				const shape = this.getShape(id)!
				const util = this.getShapeUtil(shape)
				if (shape && util.canCrop(shape)) {
					this.updateCurrentPageState({ croppingShapeId: id })
				}
			}
		}
		return this
	}

	/* --------------------- Camera --------------------- */

	/** @internal */
	@computed
	private getCameraId() {
		return CameraRecordType.createId(this.getCurrentPageId())
	}

	/**
	 * The current camera.
	 *
	 * @public
	 */
	@computed getCamera() {
		return this.store.get(this.getCameraId())!
	}

	/**
	 * The current camera zoom level.
	 *
	 * @public
	 */
	@computed getZoomLevel() {
		return this.getCamera().z
	}

	/** @internal */
	private _setCamera(point: VecLike, immediate = false): this {
		const currentCamera = this.getCamera()

		if (currentCamera.x === point.x && currentCamera.y === point.y && currentCamera.z === point.z) {
			return this
		}

		this.batch(() => {
			const camera = { ...currentCamera, ...point }
			this.store.put([camera]) // include id and meta here

			// Dispatch a new pointer move because the pointer's page will have changed
			// (its screen position will compute to a new page position given the new camera position)
			const { currentScreenPoint, currentPagePoint } = this.inputs
			const { screenBounds } = this.store.unsafeGetWithoutCapture(TLINSTANCE_ID)!

			// compare the next page point (derived from the curent camera) to the current page point
			if (
				currentScreenPoint.x / camera.z - camera.x !== currentPagePoint.x ||
				currentScreenPoint.y / camera.z - camera.y !== currentPagePoint.y
			) {
				// If it's changed, dispatch a pointer event
				const event: TLPointerEventInfo = {
					type: 'pointer',
					target: 'canvas',
					name: 'pointer_move',
					// weird but true: we need to put the screen point back into client space
					point: Vec.AddXY(currentScreenPoint, screenBounds.x, screenBounds.y),
					pointerId: INTERNAL_POINTER_IDS.CAMERA_MOVE,
					ctrlKey: this.inputs.ctrlKey,
					altKey: this.inputs.altKey,
					shiftKey: this.inputs.shiftKey,
					button: 0,
					isPen: this.getInstanceState().isPenMode ?? false,
				}
				if (immediate) {
					this._flushEventForTick(event)
				} else {
					this.dispatch(event)
				}
			}

			this._tickCameraState()
		})

		return this
	}

	/**
	 * Set the current camera.
	 *
	 * @example
	 * ```ts
	 * editor.setCamera({ x: 0, y: 0})
	 * editor.setCamera({ x: 0, y: 0, z: 1.5})
	 * editor.setCamera({ x: 0, y: 0, z: 1.5}, { duration: 1000, easing: (t) => t * t })
	 * ```
	 *
	 * @param point - The new camera position.
	 * @param animation - Options for an animation.
	 *
	 * @public
	 */
	setCamera(point: VecLike, animation?: TLAnimationOptions): this {
		const x = Number.isFinite(point.x) ? point.x : 0
		const y = Number.isFinite(point.y) ? point.y : 0
		const z = Number.isFinite(point.z) ? point.z! : this.getZoomLevel()

		// Stop any camera animations
		this.stopCameraAnimation()

		// Stop following any user
		if (this.getInstanceState().followingUserId) {
			this.stopFollowingUser()
		}

		if (animation) {
			const { width, height } = this.getViewportScreenBounds()
			return this._animateToViewport(new Box(-x, -y, width / z, height / z), animation)
		} else {
			this._setCamera({ x, y, z })
		}

		return this
	}

	/**
	 * Center the camera on a point (in the current page space).
	 *
	 * @example
	 * ```ts
	 * editor.centerOnPoint({ x: 100, y: 100 })
	 * editor.centerOnPoint({ x: 100, y: 100 }, { duration: 200 })
	 * ```
	 *
	 * @param point - The point in the current page space to center on.
	 * @param animation - The options for an animation.
	 *
	 * @public
	 */
	centerOnPoint(point: VecLike, animation?: TLAnimationOptions): this {
		if (!this.getInstanceState().canMoveCamera) return this

		const { width: pw, height: ph } = this.getViewportPageBounds()

		this.setCamera(
			{ x: -(point.x - pw / 2), y: -(point.y - ph / 2), z: this.getCamera().z },
			animation
		)
		return this
	}

	/**
	 * Move the camera to the nearest content.
	 *
	 * @example
	 * ```ts
	 * editor.zoomToContent()
	 * editor.zoomToContent({ duration: 200 })
	 * ```
	 *
	 * @param opts - The options for an animation.
	 *
	 * @public
	 */
	zoomToContent(opts: TLAnimationOptions = { duration: 220 }): this {
		const bounds = this.getSelectionPageBounds() ?? this.getCurrentPageBounds()

		if (bounds) {
			this.zoomToBounds(bounds, { targetZoom: Math.min(1, this.getZoomLevel()), ...opts })
		}

		return this
	}

	/**
	 * Zoom the camera to fit the current page's content in the viewport.
	 *
	 * @example
	 * ```ts
	 * editor.zoomToFit()
	 * editor.zoomToFit({ duration: 200 })
	 * ```
	 *
	 * @param animation - The options for an animation.
	 *
	 * @public
	 */
	zoomToFit(animation?: TLAnimationOptions): this {
		if (!this.getInstanceState().canMoveCamera) return this

		const ids = [...this.getCurrentPageShapeIds()]
		if (ids.length <= 0) return this

		const pageBounds = Box.Common(compact(ids.map((id) => this.getShapePageBounds(id))))
		this.zoomToBounds(pageBounds, animation)
		return this
	}

	/**
	 * Set the zoom back to 100%.
	 *
	 * @example
	 * ```ts
	 * editor.resetZoom()
	 * editor.resetZoom(editor.getViewportScreenCenter(), { duration: 200 })
	 * editor.resetZoom(editor.getViewportScreenCenter(), { duration: 200 })
	 * ```
	 *
	 * @param point - The screen point to zoom out on. Defaults to the viewport screen center.
	 * @param animation - The options for an animation.
	 *
	 * @public
	 */
	resetZoom(point = this.getViewportScreenCenter(), animation?: TLAnimationOptions): this {
		if (!this.getInstanceState().canMoveCamera) return this

		const { x: cx, y: cy, z: cz } = this.getCamera()
		const { x, y } = point
		this.setCamera(
			{ x: cx + (x / 1 - x) - (x / cz - x), y: cy + (y / 1 - y) - (y / cz - y), z: 1 },
			animation
		)

		return this
	}

	/**
	 * Zoom the camera in.
	 *
	 * @example
	 * ```ts
	 * editor.zoomIn()
	 * editor.zoomIn(editor.getViewportScreenCenter(), { duration: 120 })
	 * editor.zoomIn(editor.inputs.currentScreenPoint, { duration: 120 })
	 * ```
	 *
	 * @param animation - The options for an animation.
	 *
	 * @public
	 */
	zoomIn(point = this.getViewportScreenCenter(), animation?: TLAnimationOptions): this {
		if (!this.getInstanceState().canMoveCamera) return this

		const { x: cx, y: cy, z: cz } = this.getCamera()

		let zoom = MAX_ZOOM

		for (let i = 1; i < ZOOMS.length; i++) {
			const z1 = ZOOMS[i - 1]
			const z2 = ZOOMS[i]
			if (z2 - cz <= (z2 - z1) / 2) continue
			zoom = z2
			break
		}

		const { x, y } = point
		this.setCamera(
			{ x: cx + (x / zoom - x) - (x / cz - x), y: cy + (y / zoom - y) - (y / cz - y), z: zoom },
			animation
		)

		return this
	}

	/**
	 * Zoom the camera out.
	 *
	 * @example
	 * ```ts
	 * editor.zoomOut()
	 * editor.zoomOut(editor.getViewportScreenCenter(), { duration: 120 })
	 * editor.zoomOut(editor.inputs.currentScreenPoint, { duration: 120 })
	 * ```
	 *
	 * @param animation - The options for an animation.
	 *
	 * @public
	 */
	zoomOut(point = this.getViewportScreenCenter(), animation?: TLAnimationOptions): this {
		if (!this.getInstanceState().canMoveCamera) return this

		const { x: cx, y: cy, z: cz } = this.getCamera()

		let zoom = MIN_ZOOM

		for (let i = ZOOMS.length - 1; i > 0; i--) {
			const z1 = ZOOMS[i - 1]
			const z2 = ZOOMS[i]
			if (z2 - cz >= (z2 - z1) / 2) continue
			zoom = z1
			break
		}

		const { x, y } = point

		this.setCamera(
			{
				x: cx + (x / zoom - x) - (x / cz - x),
				y: cy + (y / zoom - y) - (y / cz - y),
				z: zoom,
			},
			animation
		)

		return this
	}

	/**
	 * Zoom the camera to fit the current selection in the viewport.
	 *
	 * @example
	 * ```ts
	 * editor.zoomToSelection()
	 * ```
	 *
	 * @param animation - The options for an animation.
	 *
	 * @public
	 */
	zoomToSelection(animation?: TLAnimationOptions): this {
		if (!this.getInstanceState().canMoveCamera) return this

		const selectionPageBounds = this.getSelectionPageBounds()
		if (!selectionPageBounds) return this

		this.zoomToBounds(selectionPageBounds, {
			targetZoom: Math.max(1, this.getZoomLevel()),
			...animation,
		})

		return this
	}

	/**
	 * Pan or pan/zoom the selected ids into view. This method tries to not change the zoom if possible.
	 *
	 * @param ids - The ids of the shapes to pan and zoom into view.
	 * @param animation - The options for an animation.
	 *
	 * @public
	 */
	panZoomIntoView(ids: TLShapeId[], animation?: TLAnimationOptions): this {
		if (!this.getInstanceState().canMoveCamera) return this

		if (ids.length <= 0) return this
		const selectionBounds = Box.Common(compact(ids.map((id) => this.getShapePageBounds(id))))

		const viewportPageBounds = this.getViewportPageBounds()

		if (viewportPageBounds.h < selectionBounds.h || viewportPageBounds.w < selectionBounds.w) {
			this.zoomToBounds(selectionBounds, { targetZoom: this.getCamera().z, ...animation })

			return this
		} else {
			const insetViewport = this.getViewportPageBounds()
				.clone()
				.expandBy(-32 / this.getZoomLevel())

			let offsetX = 0
			let offsetY = 0
			if (insetViewport.maxY < selectionBounds.maxY) {
				// off bottom
				offsetY = insetViewport.maxY - selectionBounds.maxY
			} else if (insetViewport.minY > selectionBounds.minY) {
				// off top
				offsetY = insetViewport.minY - selectionBounds.minY
			} else {
				// inside y-bounds
			}

			if (insetViewport.maxX < selectionBounds.maxX) {
				// off right
				offsetX = insetViewport.maxX - selectionBounds.maxX
			} else if (insetViewport.minX > selectionBounds.minX) {
				// off left
				offsetX = insetViewport.minX - selectionBounds.minX
			} else {
				// inside x-bounds
			}

			const camera = this.getCamera()
			this.setCamera({ x: camera.x + offsetX, y: camera.y + offsetY, z: camera.z }, animation)
		}

		return this
	}

	/**
	 * Zoom the camera to fit a bounding box (in the current page space).
	 *
	 * @example
	 * ```ts
	 * editor.zoomToBounds(myBounds)
	 * editor.zoomToBounds(myBounds)
	 * editor.zoomToBounds(myBounds, { duration: 100 })
	 * editor.zoomToBounds(myBounds, { inset: 0, targetZoom: 1 })
	 * ```
	 *
	 * @param bounds - The bounding box.
	 * @param options - The options for an animation, target zoom, or custom inset amount.
	 *
	 * @public
	 */
	zoomToBounds(
		bounds: Box,
		opts?: { targetZoom?: number; inset?: number } & TLAnimationOptions
	): this {
		if (!this.getInstanceState().canMoveCamera) return this

		const viewportScreenBounds = this.getViewportScreenBounds()

		const inset = opts?.inset ?? Math.min(256, viewportScreenBounds.width * 0.28)

		let zoom = clamp(
			Math.min(
				(viewportScreenBounds.width - inset) / bounds.width,
				(viewportScreenBounds.height - inset) / bounds.height
			),
			MIN_ZOOM,
			MAX_ZOOM
		)

		if (opts?.targetZoom !== undefined) {
			zoom = Math.min(opts.targetZoom, zoom)
		}

		this.setCamera(
			{
				x: -bounds.minX + (viewportScreenBounds.width - bounds.width * zoom) / 2 / zoom,
				y: -bounds.minY + (viewportScreenBounds.height - bounds.height * zoom) / 2 / zoom,
				z: zoom,
			},
			opts
		)

		return this
	}

	/**
	 * Pan the camera.
	 *
	 * @example
	 * ```ts
	 * editor.pan({ x: 100, y: 100 })
	 * editor.pan({ x: 100, y: 100 }, { duration: 1000 })
	 * ```
	 *
	 * @param offset - The offset in the current page space.
	 * @param animation - The animation options.
	 */
	pan(offset: VecLike, animation?: TLAnimationOptions): this {
		if (!this.getInstanceState().canMoveCamera) return this
		const { x: cx, y: cy, z: cz } = this.getCamera()
		this.setCamera({ x: cx + offset.x / cz, y: cy + offset.y / cz, z: cz }, animation)
		this._flushEventsForTick(0)
		return this
	}

	/**
	 * Stop the current camera animation, if any.
	 *
	 * @public
	 */
	stopCameraAnimation(): this {
		this.emit('stop-camera-animation')
		return this
	}

	/** @internal */
	private _viewportAnimation = null as null | {
		elapsed: number
		duration: number
		easing: (t: number) => number
		start: Box
		end: Box
	}

	/** @internal */
	private _animateViewport(ms: number) {
		if (!this._viewportAnimation) return

		const cancel = () => {
			this.removeListener('tick', this._animateViewport)
			this.removeListener('stop-camera-animation', cancel)
			this._viewportAnimation = null
		}

		this.once('stop-camera-animation', cancel)

		this._viewportAnimation.elapsed += ms

		const { elapsed, easing, duration, start, end } = this._viewportAnimation

		if (elapsed > duration) {
			this._setCamera({ x: -end.x, y: -end.y, z: this.getViewportScreenBounds().width / end.width })
			cancel()
			return
		}

		const remaining = duration - elapsed
		const t = easing(1 - remaining / duration)

		const left = start.minX + (end.minX - start.minX) * t
		const top = start.minY + (end.minY - start.minY) * t
		const right = start.maxX + (end.maxX - start.maxX) * t

		this._setCamera({ x: -left, y: -top, z: this.getViewportScreenBounds().width / (right - left) })
	}

	/** @internal */
	private _animateToViewport(targetViewportPage: Box, opts = {} as TLAnimationOptions) {
		const { duration = 0, easing = EASINGS.easeInOutCubic } = opts
		const animationSpeed = this.user.getAnimationSpeed()
		const viewportPageBounds = this.getViewportPageBounds()

		// If we have an existing animation, then stop it
		this.stopCameraAnimation()

		// also stop following any user
		if (this.getInstanceState().followingUserId) {
			this.stopFollowingUser()
		}

		if (duration === 0 || animationSpeed === 0) {
			// If we have no animation, then skip the animation and just set the camera
			return this._setCamera({
				x: -targetViewportPage.x,
				y: -targetViewportPage.y,
				z: this.getViewportScreenBounds().width / targetViewportPage.width,
			})
		}

		// Set our viewport animation
		this._viewportAnimation = {
			elapsed: 0,
			duration: duration / animationSpeed,
			easing,
			start: viewportPageBounds.clone(),
			end: targetViewportPage.clone(),
		}

		// On each tick, animate the viewport
		this.addListener('tick', this._animateViewport)

		return this
	}

	/**
	 * Slide the camera in a certain direction.
	 *
	 * @param opts - Options for the slide
	 * @public
	 */
	slideCamera(
		opts = {} as {
			speed: number
			direction: VecLike
			friction: number
			speedThreshold?: number
		}
	): this {
		if (!this.getInstanceState().canMoveCamera) return this

		this.stopCameraAnimation()

		const animationSpeed = this.user.getAnimationSpeed()

		if (animationSpeed === 0) return this

		const { speed, friction, direction, speedThreshold = 0.01 } = opts
		let currentSpeed = Math.min(speed, 1)

		const cancel = () => {
			this.removeListener('tick', moveCamera)
			this.removeListener('stop-camera-animation', cancel)
		}

		this.once('stop-camera-animation', cancel)

		const moveCamera = (elapsed: number) => {
			const { x: cx, y: cy, z: cz } = this.getCamera()
			const movementVec = Vec.Mul(direction, (currentSpeed * elapsed) / cz)

			// Apply friction
			currentSpeed *= 1 - friction
			if (currentSpeed < speedThreshold) {
				cancel()
			} else {
				this._setCamera({ x: cx + movementVec.x, y: cy + movementVec.y, z: cz })
			}
		}

		this.addListener('tick', moveCamera)

		return this
	}

	/**
	 * Animate the camera to a user's cursor position.
	 * This also briefly show the user's cursor if it's not currently visible.
	 *
	 * @param userId - The id of the user to aniamte to.
	 * @public
	 */
	animateToUser(userId: string): this {
		const presence = this.getCollaborators().find((c) => c.userId === userId)

		if (!presence) return this

		this.batch(() => {
			// If we're following someone, stop following them
			if (this.getInstanceState().followingUserId !== null) {
				this.stopFollowingUser()
			}

			// If we're not on the same page, move to the page they're on
			const isOnSamePage = presence.currentPageId === this.getCurrentPageId()
			if (!isOnSamePage) {
				this.setCurrentPage(presence.currentPageId)
			}

			// Only animate the camera if the user is on the same page as us
			const options = isOnSamePage ? { duration: 500 } : undefined

			this.centerOnPoint(presence.cursor, options)

			// Highlight the user's cursor
			const { highlightedUserIds } = this.getInstanceState()
			this.updateInstanceState({ highlightedUserIds: [...highlightedUserIds, userId] })

			// Unhighlight the user's cursor after a few seconds
			setTimeout(() => {
				const highlightedUserIds = [...this.getInstanceState().highlightedUserIds]
				const index = highlightedUserIds.indexOf(userId)
				if (index < 0) return
				highlightedUserIds.splice(index, 1)
				this.updateInstanceState({ highlightedUserIds })
			}, COLLABORATOR_IDLE_TIMEOUT)
		})

		return this
	}

	/**
	 * Animate the camera to a shape.
	 *
	 * @public
	 */
	animateToShape(shapeId: TLShapeId, opts: TLAnimationOptions = DEFAULT_ANIMATION_OPTIONS): this {
		if (!this.getInstanceState().canMoveCamera) return this

		const activeArea = this.getViewportScreenBounds().clone().expandBy(-32)
		const viewportAspectRatio = activeArea.width / activeArea.height

		const shapePageBounds = this.getShapePageBounds(shapeId)

		if (!shapePageBounds) return this

		const shapeAspectRatio = shapePageBounds.width / shapePageBounds.height

		const targetViewportPage = shapePageBounds.clone()

		const z = shapePageBounds.width / activeArea.width
		targetViewportPage.width += (activeArea.minX + activeArea.maxX) * z
		targetViewportPage.height += (activeArea.minY + activeArea.maxY) * z
		targetViewportPage.x -= activeArea.minX * z
		targetViewportPage.y -= activeArea.minY * z

		if (shapeAspectRatio > viewportAspectRatio) {
			targetViewportPage.height = shapePageBounds.width / viewportAspectRatio
			targetViewportPage.y -= (targetViewportPage.height - shapePageBounds.height) / 2
		} else {
			targetViewportPage.width = shapePageBounds.height * viewportAspectRatio
			targetViewportPage.x -= (targetViewportPage.width - shapePageBounds.width) / 2
		}

		return this._animateToViewport(targetViewportPage, opts)
	}

	// Viewport

	/** @internal */
	private _willSetInitialBounds = true
	private _wasInset = false

	/**
	 * Update the viewport. The viewport will measure the size and screen position of its container
	 * element. This should be done whenever the container's position on the screen changes.
	 *
	 * @example
	 * ```ts
	 * editor.updateViewportScreenBounds()
	 * editor.updateViewportScreenBounds(true)
	 * ```
	 *
	 * @param center - Whether to preserve the viewport page center as the viewport changes.
	 *
	 * @public
	 */
	updateViewportScreenBounds(screenBounds: Box, center = false): this {
		screenBounds.width = Math.max(screenBounds.width, 1)
		screenBounds.height = Math.max(screenBounds.height, 1)

		const insets = [
			// top
			screenBounds.minY !== 0,
			// right
			document.body.scrollWidth !== screenBounds.maxX,
			// bottom
			document.body.scrollHeight !== screenBounds.maxY,
			// left
			screenBounds.minX !== 0,
		]

		const boundsAreEqual = screenBounds.equals(this.getViewportScreenBounds())

		const { _willSetInitialBounds } = this

		if (boundsAreEqual) {
			this._willSetInitialBounds = false
		} else {
			if (_willSetInitialBounds) {
				// If we have just received the initial bounds, don't center the camera.
				this._willSetInitialBounds = false
				this.updateInstanceState({ screenBounds: screenBounds.toJson(), insets })
			} else {
				if (center && !this.getInstanceState().followingUserId) {
					// Get the page center before the change, make the change, and restore it
					const before = this.getViewportPageCenter()
					this.updateInstanceState({ screenBounds: screenBounds.toJson(), insets })
					this.centerOnPoint(before)
				} else {
					// Otherwise,
					this.updateInstanceState({ screenBounds: screenBounds.toJson(), insets })
				}
			}
		}

		this._tickCameraState()
		this.updateRenderingBounds()

		return this
	}

	/**
	 * The bounds of the editor's viewport in screen space.
	 *
	 * @public
	 */
	@computed getViewportScreenBounds() {
		const { x, y, w, h } = this.getInstanceState().screenBounds
		return new Box(x, y, w, h)
	}

	/**
	 * The center of the editor's viewport in screen space.
	 *
	 * @public
	 */
	@computed getViewportScreenCenter() {
		const viewportScreenBounds = this.getViewportScreenBounds()
		return new Vec(
			viewportScreenBounds.midX - viewportScreenBounds.minX,
			viewportScreenBounds.midY - viewportScreenBounds.minY
		)
	}

	/**
	 * The current viewport in the current page space.
	 *
	 * @public
	 */
	@computed getViewportPageBounds() {
		const { w, h } = this.getViewportScreenBounds()
		const { x: cx, y: cy, z: cz } = this.getCamera()
		return new Box(-cx, -cy, w / cz, h / cz)
	}

	/**
	 * The center of the viewport in the current page space.
	 *
	 * @public
	 */
	@computed getViewportPageCenter() {
		return this.getViewportPageBounds().center
	}
	/**
	 * Convert a point in screen space to a point in the current page space.
	 *
	 * @example
	 * ```ts
	 * editor.screenToPage({ x: 100, y: 100 })
	 * ```
	 *
	 * @param point - The point in screen space.
	 *
	 * @public
	 */
	screenToPage(point: VecLike) {
		const { screenBounds } = this.store.unsafeGetWithoutCapture(TLINSTANCE_ID)!
		const { x: cx, y: cy, z: cz = 1 } = this.getCamera()
		return {
			x: (point.x - screenBounds.x) / cz - cx,
			y: (point.y - screenBounds.y) / cz - cy,
			z: point.z ?? 0.5,
		}
	}

	/**
	 * Convert a point in the current page space to a point in current screen space.
	 *
	 * @example
	 * ```ts
	 * editor.pageToScreen({ x: 100, y: 100 })
	 * ```
	 *
	 * @param point - The point in page space.
	 *
	 * @public
	 */
	pageToScreen(point: VecLike) {
		const screenBounds = this.getViewportScreenBounds()
		const { x: cx, y: cy, z: cz = 1 } = this.getCamera()

		return {
			x: (point.x + cx) * cz + screenBounds.x,
			y: (point.y + cy) * cz + screenBounds.y,
			z: point.z ?? 0.5,
		}
	}

	/**
	 * Convert a point in the current page space to a point in current viewport space.
	 *
	 * @example
	 * ```ts
	 * editor.pageToViewport({ x: 100, y: 100 })
	 * ```
	 *
	 * @param point - The point in page space.
	 *
	 * @public
	 */
	pageToViewport(point: VecLike) {
		const { x: cx, y: cy, z: cz = 1 } = this.getCamera()

		return {
			x: (point.x + cx) * cz,
			y: (point.y + cy) * cz,
			z: point.z ?? 0.5,
		}
	}
	// Collaborators

	@computed
	private _getCollaboratorsQuery() {
		return this.store.query.records('instance_presence', () => ({
			userId: { neq: this.user.getId() },
		}))
	}

	/**
	 * Returns a list of presence records for all peer collaborators.
	 * This will return the latest presence record for each connected user.
	 *
	 * @public
	 */
	@computed
	getCollaborators() {
		const allPresenceRecords = this._getCollaboratorsQuery().get()
		if (!allPresenceRecords.length) return EMPTY_ARRAY
		const userIds = [...new Set(allPresenceRecords.map((c) => c.userId))].sort()
		return userIds.map((id) => {
			const latestPresence = allPresenceRecords
				.filter((c) => c.userId === id)
				.sort((a, b) => b.lastActivityTimestamp - a.lastActivityTimestamp)[0]
			return latestPresence
		})
	}

	/**
	 * Returns a list of presence records for all peer collaborators on the current page.
	 * This will return the latest presence record for each connected user.
	 *
	 * @public
	 */
	@computed
	getCollaboratorsOnCurrentPage() {
		const currentPageId = this.getCurrentPageId()
		return this.getCollaborators().filter((c) => c.currentPageId === currentPageId)
	}

	// Following

	/**
	 * Start viewport-following a user.
	 *
	 * @param userId - The id of the user to follow.
	 *
	 * @public
	 */
	startFollowingUser(userId: string): this {
		const leaderPresences = this._getCollaboratorsQuery()
			.get()
			.filter((p) => p.userId === userId)

		const thisUserId = this.user.getId()

		if (!thisUserId) {
			console.warn('You should set the userId for the current instance before following a user')
		}

		// If the leader is following us, then we can't follow them
		if (leaderPresences.some((p) => p.followingUserId === thisUserId)) {
			return this
		}

		transact(() => {
			this.stopFollowingUser()

			this.updateInstanceState({ followingUserId: userId })
		})

		const cancel = () => {
			this.removeListener('frame', moveTowardsUser)
			this.removeListener('stop-following', cancel)
		}

		let isCaughtUp = false

		const moveTowardsUser = () => {
			// Stop following if we can't find the user
			const leaderPresence = [...leaderPresences]
				.sort((a, b) => {
					return a.lastActivityTimestamp - b.lastActivityTimestamp
				})
				.pop()
			if (!leaderPresence) {
				this.stopFollowingUser()
				return
			}

			// Change page if leader is on a different page
			const isOnSamePage = leaderPresence.currentPageId === this.getCurrentPageId()
			const chaseProportion = isOnSamePage ? FOLLOW_CHASE_PROPORTION : 1
			if (!isOnSamePage) {
				this.stopFollowingUser()
				this.setCurrentPage(leaderPresence.currentPageId)
				this.startFollowingUser(userId)
				return
			}

			// Get the bounds of the follower (me) and the leader (them)
			const { center, width, height } = this.getViewportPageBounds()
			const leaderScreen = Box.From(leaderPresence.screenBounds)
			const leaderWidth = leaderScreen.width / leaderPresence.camera.z
			const leaderHeight = leaderScreen.height / leaderPresence.camera.z
			const leaderCenter = new Vec(
				leaderWidth / 2 - leaderPresence.camera.x,
				leaderHeight / 2 - leaderPresence.camera.y
			)

			// At this point, let's check if we're following someone who's following us.
			// If so, we can't try to contain their entire viewport
			// because that would become a feedback loop where we zoom, they zoom, etc.
			const isFollowingFollower = leaderPresence.followingUserId === thisUserId

			// Figure out how much to zoom
			const desiredWidth = width + (leaderWidth - width) * chaseProportion
			const desiredHeight = height + (leaderHeight - height) * chaseProportion
			const ratio = !isFollowingFollower
				? Math.min(width / desiredWidth, height / desiredHeight)
				: height / desiredHeight

			const targetZoom = clamp(this.getCamera().z * ratio, MIN_ZOOM, MAX_ZOOM)
			const targetWidth = this.getViewportScreenBounds().w / targetZoom
			const targetHeight = this.getViewportScreenBounds().h / targetZoom

			// Figure out where to move the camera
			const displacement = leaderCenter.sub(center)
			const targetCenter = Vec.Add(center, Vec.Mul(displacement, chaseProportion))

			// Now let's assess whether we've caught up to the leader or not
			const distance = Vec.Sub(targetCenter, center).len()
			const zoomChange = Math.abs(targetZoom - this.getCamera().z)

			// If we're chasing the leader...
			// Stop chasing if we're close enough
			if (distance < FOLLOW_CHASE_PAN_SNAP && zoomChange < FOLLOW_CHASE_ZOOM_SNAP) {
				isCaughtUp = true
				return
			}

			// If we're already caught up with the leader...
			// Only start moving again if we're far enough away
			if (
				isCaughtUp &&
				distance < FOLLOW_CHASE_PAN_UNSNAP &&
				zoomChange < FOLLOW_CHASE_ZOOM_UNSNAP
			) {
				return
			}

			// Update the camera!
			isCaughtUp = false
			this.stopCameraAnimation()
			this._setCamera({
				x: -(targetCenter.x - targetWidth / 2),
				y: -(targetCenter.y - targetHeight / 2),
				z: targetZoom,
			})
		}

		this.once('stop-following', cancel)
		this.addListener('frame', moveTowardsUser)

		return this
	}

	/**
	 * Stop viewport-following a user.
	 *
	 * @public
	 */
	stopFollowingUser(): this {
		this.updateInstanceState({ followingUserId: null })
		this.emit('stop-following')
		return this
	}

	// Camera state

	private _cameraState = atom('camera state', 'idle' as 'idle' | 'moving')

	/**
	 * Whether the camera is moving or idle.
	 *
	 * @public
	 */
	getCameraState() {
		return this._cameraState.get()
	}

	// Camera state does two things: first, it allows us to subscribe to whether
	// the camera is moving or not; and second, it allows us to update the rendering
	// shapes on the canvas. Changing the rendering shapes may cause shapes to
	// unmount / remount in the DOM, which is expensive; and computing visibility is
	// also expensive in large projects. For this reason, we use a second bounding
	// box just for rendering, and we only update after the camera stops moving.

	private _cameraStateTimeoutRemaining = 0
	private _lastUpdateRenderingBoundsTimestamp = Date.now()

	private _decayCameraStateTimeout = (elapsed: number) => {
		this._cameraStateTimeoutRemaining -= elapsed

		if (this._cameraStateTimeoutRemaining <= 0) {
			this.off('tick', this._decayCameraStateTimeout)
			this._cameraState.set('idle')
			this.updateRenderingBounds()
		}
	}

	private _tickCameraState = () => {
		// always reset the timeout
		this._cameraStateTimeoutRemaining = CAMERA_MOVING_TIMEOUT

		const now = Date.now()

		// If the state is idle, then start the tick
		if (this._cameraState.__unsafe__getWithoutCapture() === 'idle') {
			this._lastUpdateRenderingBoundsTimestamp = now // don't render right away
			this._cameraState.set('moving')
			this.on('tick', this._decayCameraStateTimeout)
		}
	}

	/** @internal */
	getUnorderedRenderingShapes(
		// The rendering state. We use this method both for rendering, which
		// is based on other state, and for computing order for SVG export,
		// which should work even when things are for example off-screen.
		useEditorState: boolean
	) {
		// Here we get the shape as well as any of its children, as well as their
		// opacities. If the shape is being erased, and none of its ancestors are
		// being erased, then we reduce the opacity of the shape and all of its
		// ancestors; but we don't apply this effect more than once among a set
		// of descendants so that it does not compound.

		// This is designed to keep all the shapes in a single list which
		// allows the DOM nodes to be reused even when they become children
		// of other nodes.

		const renderingShapes: {
			id: TLShapeId
			shape: TLShape
			util: ShapeUtil
			index: number
			backgroundIndex: number
			opacity: number
		}[] = []

		let nextIndex = MAX_SHAPES_PER_PAGE * 2
		let nextBackgroundIndex = MAX_SHAPES_PER_PAGE

		const erasingShapeIds = this.getErasingShapeIds()

		const addShapeById = (id: TLShapeId, opacity: number, isAncestorErasing: boolean) => {
			const shape = this.getShape(id)
			if (!shape) return

			opacity *= shape.opacity
			let isShapeErasing = false
			const util = this.getShapeUtil(shape)

			if (useEditorState) {
				isShapeErasing = !isAncestorErasing && erasingShapeIds.includes(id)
				if (isShapeErasing) {
					opacity *= 0.32
				}
			}

			renderingShapes.push({
				id,
				shape,
				util,
				index: nextIndex,
				backgroundIndex: nextBackgroundIndex,
				opacity,
			})

			nextIndex += 1
			nextBackgroundIndex += 1

			const childIds = this.getSortedChildIdsForParent(id)
			if (!childIds.length) return

			let backgroundIndexToRestore = null
			if (util.providesBackgroundForChildren(shape)) {
				backgroundIndexToRestore = nextBackgroundIndex
				nextBackgroundIndex = nextIndex
				nextIndex += MAX_SHAPES_PER_PAGE
			}

			for (const childId of childIds) {
				addShapeById(childId, opacity, isAncestorErasing || isShapeErasing)
			}

			if (backgroundIndexToRestore !== null) {
				nextBackgroundIndex = backgroundIndexToRestore
			}
		}

		// If we're using editor state, then we're only interested in on-screen shapes.
		// If we're not using the editor state, then we're interested in ALL shapes, even those from other pages.
		const pages = useEditorState ? [this.getCurrentPage()] : this.getPages()
		for (const page of pages) {
			for (const childId of this.getSortedChildIdsForParent(page.id)) {
				addShapeById(childId, 1, false)
			}
		}

		return renderingShapes
	}

	/**
	 * Get the shapes that should be displayed in the current viewport.
	 *
	 * @public
	 */
	@computed getRenderingShapes() {
		const renderingShapes = this.getUnorderedRenderingShapes(true)

		// Its IMPORTANT that the result be sorted by id AND include the index
		// that the shape should be displayed at. Steve, this is the past you
		// telling the present you not to change this.

		// We want to sort by id because moving elements about in the DOM will
		// cause the element to get removed by react as it moves the DOM node. This
		// causes <iframes/> to re-render which is hella annoying and a perf
		// drain. By always sorting by 'id' we keep the shapes always in the
		// same order; but we later use index to set the element's 'z-index'
		// to change the "rendered" position in z-space.
		return renderingShapes.sort(sortById)
	}

	/**
	 * The current rendering bounds in the current page space, used for checking which shapes are "on screen".
	 *
	 * @public
	 */
	getRenderingBounds() {
		return this._renderingBounds.get()
	}

	/** @internal */
	private readonly _renderingBounds = atom('rendering viewport', new Box())

	/**
	 * Update the rendering bounds. This should be called when the viewport has stopped changing, such
	 * as at the end of a pan, zoom, or animation.
	 *
	 * @example
	 * ```ts
	 * editor.updateRenderingBounds()
	 * ```
	 *
	 *
	 * @internal
	 */
	updateRenderingBounds(): this {
		const viewportPageBounds = this.getViewportPageBounds()
		if (viewportPageBounds.equals(this._renderingBounds.__unsafe__getWithoutCapture())) return this
		this._renderingBounds.set(viewportPageBounds.clone())

		return this
	}

	/**
	 * The distance to expand the viewport when measuring culling. A larger distance will
	 * mean that shapes near to the viewport (but still outside of it) will not be culled.
	 *
	 * @public
	 */
	renderingBoundsMargin = 100

	/* --------------------- Pages ---------------------- */

	@computed private _getAllPagesQuery() {
		return this.store.query.records('page')
	}

	/**
	 * Info about the project's current pages.
	 *
	 * @public
	 */
	@computed getPages(): TLPage[] {
		return this._getAllPagesQuery().get().sort(sortByIndex)
	}

	/**
	 * The current page.
	 *
	 * @public
	 */
	getCurrentPage(): TLPage {
		return this.getPage(this.getCurrentPageId())!
	}

	/**
	 * The current page id.
	 *
	 * @public
	 */
	@computed getCurrentPageId(): TLPageId {
		return this.getInstanceState().currentPageId
	}

	/**
	 * Get a page.
	 *
	 * @example
	 * ```ts
	 * editor.getPage(myPage.id)
	 * editor.getPage(myPage)
	 * ```
	 *
	 * @param page - The page (or page id) to get.
	 *
	 * @public
	 */
	getPage(page: TLPageId | TLPage): TLPage | undefined {
		return this.store.get(typeof page === 'string' ? page : page.id)
	}

	/* @internal */
	private readonly _currentPageShapeIds: ReturnType<typeof deriveShapeIdsInCurrentPage>

	/**
	 * An array of all of the shapes on the current page.
	 *
	 * @public
	 */
	getCurrentPageShapeIds() {
		return this._currentPageShapeIds.get()
	}

	/**
	 * @internal
	 */
	@computed
	getCurrentPageShapeIdsSorted() {
		return Array.from(this.getCurrentPageShapeIds()).sort()
	}

	/**
	 * Get the ids of shapes on a page.
	 *
	 * @example
	 * ```ts
	 * const idsOnPage1 = editor.getPageShapeIds('page1')
	 * const idsOnPage2 = editor.getPageShapeIds(myPage2)
	 * ```
	 *
	 * @param page - The page (or page id) to get.
	 *
	 * @public
	 **/
	getPageShapeIds(page: TLPageId | TLPage): Set<TLShapeId> {
		const pageId = typeof page === 'string' ? page : page.id
		const result = this.store.query.exec('shape', { parentId: { eq: pageId } })
		return this.getShapeAndDescendantIds(result.map((s) => s.id))
	}

	/**
	 * Set the current page.
	 *
	 * @example
	 * ```ts
	 * editor.setCurrentPage('page1')
	 * editor.setCurrentPage(myPage1)
	 * ```
	 *
	 * @param page - The page (or page id) to set as the current page.
	 *
	 * @public
	 */
	setCurrentPage(page: TLPageId | TLPage): this {
		const pageId = typeof page === 'string' ? page : page.id

		if (!this.store.has(pageId)) {
			console.error("Tried to set the current page id to a page that doesn't exist.")
			return this
		}

		this.stopFollowingUser()

		return this.batch(
			() => this.store.put([{ ...this.getInstanceState(), currentPageId: pageId }]),
			{ history: 'record-preserveRedoStack' }
		)
	}

	/**
	 * Update a page.
	 *
	 * @example
	 * ```ts
	 * editor.updatePage({ id: 'page2', name: 'Page 2' })
	 * ```
	 *
	 * @param partial - The partial of the shape to update.
	 *
	 * @public
	 */
	updatePage(partial: RequiredKeys<TLPage, 'id'>): this {
		if (this.getInstanceState().isReadonly) return this

		const prev = this.getPage(partial.id)
		if (!prev) return this

		return this.batch(() => this.store.update(partial.id, (page) => ({ ...page, ...partial })))
	}

	/**
	 * Create a page.
	 *
	 * @example
	 * ```ts
	 * editor.createPage(myPage)
	 * editor.createPage({ name: 'Page 2' })
	 * ```
	 *
	 * @param page - The page (or page partial) to create.
	 *
	 * @public
	 */
	createPage(page: Partial<TLPage>): this {
		this.history.batch(() => {
			if (this.getInstanceState().isReadonly) return
			if (this.getPages().length >= MAX_PAGES) return
			const pages = this.getPages()

			const name = getIncrementedName(
				page.name ?? 'Page 1',
				pages.map((p) => p.name)
			)

			let index = page.index

			if (!index || pages.some((p) => p.index === index)) {
				index = getIndexAbove(pages[pages.length - 1].index)
			}

			const newPage = PageRecordType.create({
				meta: {},
				...page,
				name,
				index,
			})

			this.store.put([newPage])
		})
		return this
	}

	/**
	 * Delete a page.
	 *
	 * @example
	 * ```ts
	 * editor.deletePage('page1')
	 * ```
	 *
	 * @param id - The id of the page to delete.
	 *
	 * @public
	 */
	deletePage(page: TLPageId | TLPage): this {
		const id = typeof page === 'string' ? page : page.id
		this.batch(() => {
			if (this.getInstanceState().isReadonly) return
			const pages = this.getPages()
			if (pages.length === 1) return

			const deletedPage = this.getPage(id)
			if (!deletedPage) return

			if (id === this.getCurrentPageId()) {
				const index = pages.findIndex((page) => page.id === id)
				const next = pages[index - 1] ?? pages[index + 1]
				this.setCurrentPage(next.id)
			}

			this.store.remove([deletedPage.id])
			this.updateRenderingBounds()
		})
		return this
	}

	/**
	 * Duplicate a page.
	 *
	 * @param id - The id of the page to duplicate. Defaults to the current page.
	 * @param createId - The id of the new page. Defaults to a new id.
	 *
	 * @public
	 */
	duplicatePage(page: TLPageId | TLPage, createId: TLPageId = PageRecordType.createId()): this {
		if (this.getPages().length >= MAX_PAGES) return this
		const id = typeof page === 'string' ? page : page.id
		const freshPage = this.getPage(id) // get the most recent version of the page anyway
		if (!freshPage) return this

		const prevCamera = { ...this.getCamera() }
		const content = this.getContentFromCurrentPage(this.getSortedChildIdsForParent(freshPage.id))

		this.batch(() => {
			const pages = this.getPages()
			const index = getIndexBetween(freshPage.index, pages[pages.indexOf(freshPage) + 1]?.index)

			// create the page (also creates the pagestate and camera for the new page)
			this.createPage({ name: freshPage.name + ' Copy', id: createId, index })
			// set the new page as the current page
			this.setCurrentPage(createId)
			// update the new page's camera to the previous page's camera
			this.setCamera(prevCamera)

			if (content) {
				// If we had content on the previous page, put it on the new page
				return this.putContentOntoCurrentPage(content)
			}
		})

		return this
	}

	/**
	 * Rename a page.
	 *
	 * @example
	 * ```ts
	 * editor.renamePage('page1', 'My Page')
	 * ```
	 *
	 * @param id - The id of the page to rename.
	 * @param name - The new name.
	 *
	 * @public
	 */
	renamePage(page: TLPageId | TLPage, name: string) {
		const id = typeof page === 'string' ? page : page.id
		if (this.getInstanceState().isReadonly) return this
		this.updatePage({ id, name })
		return this
	}

	/* --------------------- Assets --------------------- */

	/** @internal */
	@computed private _getAllAssetsQuery() {
		return this.store.query.records('asset')
	}

	/**
	 * Get all assets in the editor.
	 *
	 * @public
	 */
	getAssets() {
		return this._getAllAssetsQuery().get()
	}

	/**
	 * Create one or more assets.
	 *
	 * @example
	 * ```ts
	 * editor.createAssets([...myAssets])
	 * ```
	 *
	 * @param assets - The assets to create.
	 *
	 * @public
	 */
	createAssets(assets: TLAsset[]): this {
		if (this.getInstanceState().isReadonly) return this
		if (assets.length <= 0) return this
		return this.batch(() => this.store.put(assets))
	}

	/**
	 * Update one or more assets.
	 *
	 * @example
	 * ```ts
	 * editor.updateAssets([{ id: 'asset1', name: 'New name' }])
	 * ```
	 *
	 * @param assets - The assets to update.
	 *
	 * @public
	 */
	updateAssets(assets: TLAssetPartial[]): this {
		if (this.getInstanceState().isReadonly) return this
		if (assets.length <= 0) return this
		return this.batch(() => {
			this.store.put(
				assets.map((partial) => ({
					...this.store.get(partial.id)!,
					...partial,
				}))
			)
		})
	}

	/**
	 * Delete one or more assets.
	 *
	 * @example
	 * ```ts
	 * editor.deleteAssets(['asset1', 'asset2'])
	 * ```
	 *
	 * @param ids - The assets to delete.
	 *
	 * @public
	 */
	deleteAssets(assets: TLAssetId[] | TLAsset[]): this {
		if (this.getInstanceState().isReadonly) return this

		const ids =
			typeof assets[0] === 'string'
				? (assets as TLAssetId[])
				: (assets as TLAsset[]).map((a) => a.id)
		if (ids.length <= 0) return this

		return this.batch(() => this.store.remove(ids))
	}

	/**
	 * Get an asset by its id.
	 *
	 * @example
	 * ```ts
	 * editor.getAsset('asset1')
	 * ```
	 *
	 * @param asset - The asset (or asset id) to get.
	 *
	 * @public
	 */
	getAsset(asset: TLAssetId | TLAsset): TLAsset | undefined {
		return this.store.get(typeof asset === 'string' ? asset : asset.id) as TLAsset | undefined
	}

	/* --------------------- Shapes --------------------- */

	@computed
	private _getShapeGeometryCache(): ComputedCache<Geometry2d, TLShape> {
		return this.store.createComputedCache(
			'bounds',
			(shape) => this.getShapeUtil(shape).getGeometry(shape),
			(a, b) => a.props === b.props
		)
	}

	/**
	 * Get the geometry of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getShapeGeometry(myShape)
	 * editor.getShapeGeometry(myShapeId)
	 * ```
	 *
	 * @param shape - The shape (or shape id) to get the geometry for.
	 *
	 * @public
	 */
	getShapeGeometry<T extends Geometry2d>(shape: TLShape | TLShapeId): T {
		return this._getShapeGeometryCache().get(typeof shape === 'string' ? shape : shape.id)! as T
	}

	/** @internal */
	@computed private _getShapeHandlesCache(): ComputedCache<TLHandle[] | undefined, TLShape> {
		return this.store.createComputedCache('handles', (shape) => {
			return this.getShapeUtil(shape).getHandles?.(shape)
		})
	}

	/**
	 * Get the handles (if any) for a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getShapeHandles(myShape)
	 * editor.getShapeHandles(myShapeId)
	 * ```
	 *
	 * @param shape - The shape (or shape id) to get the handles for.
	 * @public
	 */
	getShapeHandles<T extends TLShape>(shape: T | T['id']): TLHandle[] | undefined {
		return this._getShapeHandlesCache().get(typeof shape === 'string' ? shape : shape.id)
	}

	/**
	 * Get the local transform for a shape as a matrix model. This transform reflects both its
	 * translation (x, y) from from either its parent's top left corner, if the shape's parent is
	 * another shape, or else from the 0,0 of the page, if the shape's parent is the page; and the
	 * shape's rotation.
	 *
	 * @example
	 * ```ts
	 * editor.getShapeLocalTransform(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the local transform for.
	 *
	 * @public
	 */
	getShapeLocalTransform(shape: TLShape | TLShapeId): Mat {
		const id = typeof shape === 'string' ? shape : shape.id
		const freshShape = this.getShape(id)
		if (!freshShape) throw Error('Editor.getTransform: shape not found')
		return Mat.Identity().translate(freshShape.x, freshShape.y).rotate(freshShape.rotation)
	}

	/**
	 * A cache of page transforms.
	 *
	 * @internal
	 */
	@computed private _getShapePageTransformCache(): ComputedCache<Mat, TLShape> {
		return this.store.createComputedCache<Mat, TLShape>('pageTransformCache', (shape) => {
			if (isPageId(shape.parentId)) {
				return this.getShapeLocalTransform(shape)
			}

			// If the shape's parent doesn't exist yet (e.g. when merging in changes from remote in the wrong order)
			// then we can't compute the transform yet, so just return the identity matrix.
			// In the future we should look at creating a store update mechanism that understands and preserves
			// ordering.
			const parentTransform =
				this._getShapePageTransformCache().get(shape.parentId) ?? Mat.Identity()
			return Mat.Compose(parentTransform, this.getShapeLocalTransform(shape)!)
		})
	}

	/**
	 * Get the local transform of a shape's parent as a matrix model.
	 *
	 * @example
	 * ```ts
	 * editor.getShapeParentTransform(myShape)
	 * ```
	 *
	 * @param shape - The shape (or shape id) to get the parent transform for.
	 *
	 * @public
	 */
	getShapeParentTransform(shape: TLShape | TLShapeId): Mat {
		const id = typeof shape === 'string' ? shape : shape.id
		const freshShape = this.getShape(id)
		if (!freshShape || isPageId(freshShape.parentId)) return Mat.Identity()
		return this._getShapePageTransformCache().get(freshShape.parentId) ?? Mat.Identity()
	}

	/**
	 * Get the transform of a shape in the current page space.
	 *
	 * @example
	 * ```ts
	 * editor.getShapePageTransform(myShape)
	 * editor.getShapePageTransform(myShapeId)
	 * ```
	 *
	 * @param shape - The shape (or shape id) to get the page transform for.
	 *
	 * @public
	 */
	getShapePageTransform(shape: TLShape | TLShapeId): Mat {
		const id = typeof shape === 'string' ? shape : shape.id
		return this._getShapePageTransformCache().get(id) ?? Mat.Identity()
	}

	/** @internal */
	@computed private _getShapePageBoundsCache(): ComputedCache<Box, TLShape> {
		return this.store.createComputedCache<Box, TLShape>('pageBoundsCache', (shape) => {
			const pageTransform = this._getShapePageTransformCache().get(shape.id)

			if (!pageTransform) return new Box()

			const result = Box.FromPoints(
				Mat.applyToPoints(pageTransform, this.getShapeGeometry(shape).vertices)
			)

			return result
		})
	}

	/**
	 * Get the bounds of a shape in the current page space.
	 *
	 * @example
	 * ```ts
	 * editor.getShapePageBounds(myShape)
	 * editor.getShapePageBounds(myShapeId)
	 * ```
	 *
	 * @param shape - The shape (or shape id) to get the bounds for.
	 *
	 * @public
	 */
	getShapePageBounds(shape: TLShape | TLShapeId): Box | undefined {
		return this._getShapePageBoundsCache().get(typeof shape === 'string' ? shape : shape.id)
	}

	/**
	 * A cache of clip paths used for clipping.
	 *
	 * @internal
	 */
	@computed private _getShapeClipPathCache(): ComputedCache<string, TLShape> {
		return this.store.createComputedCache<string, TLShape>('clipPathCache', (shape) => {
			const pageMask = this._getShapeMaskCache().get(shape.id)
			if (!pageMask) return undefined
			if (pageMask.length === 0) {
				return `polygon(0px 0px, 0px 0px, 0px 0px)`
			}

			const pageTransform = this._getShapePageTransformCache().get(shape.id)
			if (!pageTransform) return undefined

			const localMask = Mat.applyToPoints(Mat.Inverse(pageTransform), pageMask)

			return `polygon(${localMask.map((p) => `${p.x}px ${p.y}px`).join(',')})`
		})
	}

	/**
	 * Get the clip path for a shape.
	 *
	 * @example
	 * ```ts
	 * const clipPath = editor.getShapeClipPath(shape)
	 * const clipPath = editor.getShapeClipPath(shape.id)
	 * ```
	 *
	 * @param shape - The shape (or shape id) to get the clip path for.
	 *
	 * @returns The clip path or undefined.
	 *
	 * @public
	 */
	getShapeClipPath(shape: TLShape | TLShapeId): string | undefined {
		return this._getShapeClipPathCache().get(typeof shape === 'string' ? shape : shape.id)
	}

	/** @internal */
	@computed private _getShapeMaskCache(): ComputedCache<Vec[], TLShape> {
		return this.store.createComputedCache('pageMaskCache', (shape) => {
			if (isPageId(shape.parentId)) return undefined

			const frameAncestors = this.getShapeAncestors(shape.id).filter((shape) =>
				this.isShapeOfType<TLFrameShape>(shape, 'frame')
			)

			if (frameAncestors.length === 0) return undefined

			const pageMask = frameAncestors
				.map<Vec[] | undefined>((s) =>
					// Apply the frame transform to the frame outline to get the frame outline in the current page space
					this._getShapePageTransformCache()
						.get(s.id)!
						.applyToPoints(this.getShapeGeometry(s).vertices)
				)
				.reduce((acc, b) => {
					if (!(b && acc)) return undefined
					const intersection = intersectPolygonPolygon(acc, b)
					if (intersection) {
						return intersection.map(Vec.Cast)
					}
					return []
				})

			return pageMask
		})
	}

	/**
	 * Get the mask (in the current page space) for a shape.
	 *
	 * @example
	 * ```ts
	 * const pageMask = editor.getShapeMask(shape.id)
	 * ```
	 *
	 * @param id - The id of the shape to get the mask for.
	 *
	 * @returns The mask for the shape.
	 *
	 * @public
	 */
	getShapeMask(shape: TLShapeId | TLShape): VecLike[] | undefined {
		return this._getShapeMaskCache().get(typeof shape === 'string' ? shape : shape.id)
	}

	/**
	 * Get the bounds of a shape in the current page space, incorporating any masks. For example, if the
	 * shape were the child of a frame and was half way out of the frame, the bounds would be the half
	 * of the shape that was in the frame.
	 *
	 * @example
	 * ```ts
	 * editor.getShapeMaskedPageBounds(myShape)
	 * editor.getShapeMaskedPageBounds(myShapeId)
	 * ```
	 *
	 * @param shape - The shape to get the masked bounds for.
	 *
	 * @public
	 */
	getShapeMaskedPageBounds(shape: TLShapeId | TLShape): Box | undefined {
		if (typeof shape !== 'string') shape = shape.id
		return this._getShapeMaskedPageBoundsCache().get(shape)
	}

	/** @internal */
	@computed private _getShapeMaskedPageBoundsCache(): ComputedCache<Box, TLShape> {
		return this.store.createComputedCache('shapeMaskedPageBoundsCache', (shape) => {
			const pageBounds = this._getShapePageBoundsCache().get(shape.id)
			if (!pageBounds) return
			const pageMask = this._getShapeMaskCache().get(shape.id)
			if (pageMask) {
				if (pageMask.length === 0) return undefined
				const { corners } = pageBounds
				if (corners.every((p, i) => p && Vec.Equals(p, pageMask[i]))) return pageBounds.clone()
				const intersection = intersectPolygonPolygon(pageMask, corners)
				if (!intersection) return
				return Box.FromPoints(intersection)
			}
			return pageBounds
		})
	}

	/**
	 * Get the ancestors of a shape.
	 *
	 * @example
	 * ```ts
	 * const ancestors = editor.getShapeAncestors(myShape)
	 * const ancestors = editor.getShapeAncestors(myShapeId)
	 * ```
	 *
	 * @param shape - The shape (or shape id) to get the ancestors for.
	 *
	 * @public
	 */
	getShapeAncestors(shape: TLShapeId | TLShape, acc: TLShape[] = []): TLShape[] {
		const id = typeof shape === 'string' ? shape : shape.id
		const freshShape = this.getShape(id)
		if (!freshShape) return acc
		const parentId = freshShape.parentId
		if (isPageId(parentId)) {
			acc.reverse()
			return acc
		}

		const parent = this.store.get(parentId)
		if (!parent) return acc
		acc.push(parent)
		return this.getShapeAncestors(parent, acc)
	}

	/**
	 * Find the first ancestor matching the given predicate
	 *
	 * @example
	 * ```ts
	 * const ancestor = editor.findShapeAncestor(myShape)
	 * const ancestor = editor.findShapeAncestor(myShape.id)
	 * const ancestor = editor.findShapeAncestor(myShape.id, (shape) => shape.type === 'frame')
	 * ```
	 *
	 * @param shape - The shape to check the ancestors for.
	 *
	 * @public
	 */
	findShapeAncestor(
		shape: TLShape | TLShapeId,
		predicate: (parent: TLShape) => boolean
	): TLShape | undefined {
		const id = typeof shape === 'string' ? shape : shape.id
		const freshShape = this.getShape(id)
		if (!freshShape) return

		const parentId = freshShape.parentId
		if (isPageId(parentId)) return

		const parent = this.getShape(parentId)
		if (!parent) return
		return predicate(parent) ? parent : this.findShapeAncestor(parent, predicate)
	}

	/**
	 * Returns true if the the given shape has the given ancestor.
	 *
	 * @param shape - The shape.
	 * @param ancestorId - The id of the ancestor.
	 *
	 * @public
	 */
	hasAncestor(shape: TLShape | TLShapeId | undefined, ancestorId: TLShapeId): boolean {
		const id = typeof shape === 'string' ? shape : shape?.id
		const freshShape = id && this.getShape(id)
		if (!freshShape) return false
		if (freshShape.parentId === ancestorId) return true
		return this.hasAncestor(this.getShapeParent(freshShape), ancestorId)
	}

	/**
	 * Get the common ancestor of two or more shapes that matches a predicate.
	 *
	 * @param shapes - The shapes (or shape ids) to check.
	 * @param predicate - The predicate to match.
	 */
	findCommonAncestor(
		shapes: TLShape[] | TLShapeId[],
		predicate?: (shape: TLShape) => boolean
	): TLShapeId | undefined {
		if (shapes.length === 0) {
			return
		}

		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)
		const freshShapes = compact(ids.map((id) => this.getShape(id)))

		if (freshShapes.length === 1) {
			const parentId = freshShapes[0].parentId
			if (isPageId(parentId)) {
				return
			}
			return predicate ? this.findShapeAncestor(freshShapes[0], predicate)?.id : parentId
		}

		const [nodeA, ...others] = freshShapes
		let ancestor = this.getShapeParent(nodeA)
		while (ancestor) {
			// TODO: this is not ideal, optimize
			if (predicate && !predicate(ancestor)) {
				ancestor = this.getShapeParent(ancestor)
				continue
			}
			if (others.every((shape) => this.hasAncestor(shape, ancestor!.id))) {
				return ancestor!.id
			}
			ancestor = this.getShapeParent(ancestor)
		}
		return undefined
	}

	/**
	 * Check whether a shape or its parent is locked.
	 *
	 * @param shape - The shape (or shape id) to check.
	 *
	 * @public
	 */
	isShapeOrAncestorLocked(shape?: TLShape): boolean
	isShapeOrAncestorLocked(id?: TLShapeId): boolean
	isShapeOrAncestorLocked(arg?: TLShape | TLShapeId): boolean {
		const shape = typeof arg === 'string' ? this.getShape(arg) : arg
		if (shape === undefined) return false
		if (shape.isLocked) return true
		return this.isShapeOrAncestorLocked(this.getShapeParent(shape))
	}

	@computed
	private _notVisibleShapes() {
		return notVisibleShapes(this)
	}

	/**
	 * Get culled shapes.
	 *
	 * @public
	 */
	@computed
	getCulledShapes() {
		const notVisibleShapes = this._notVisibleShapes().get()
		const selectedShapeIds = this.getSelectedShapeIds()
		const editingId = this.getEditingShapeId()
		const culledShapes = new Set<TLShapeId>(notVisibleShapes)
		// we don't cull the shape we are editing
		if (editingId) {
			culledShapes.delete(editingId)
		}
		// we also don't cull selected shapes
		selectedShapeIds.forEach((id) => {
			culledShapes.delete(id)
		})
		return culledShapes
	}

	/**
	 * The bounds of the current page (the common bounds of all of the shapes on the page).
	 *
	 * @public
	 */
	@computed getCurrentPageBounds(): Box | undefined {
		let commonBounds: Box | undefined

		this.getCurrentPageShapeIdsSorted().forEach((shapeId) => {
			const bounds = this.getShapeMaskedPageBounds(shapeId)
			if (!bounds) return
			if (!commonBounds) {
				commonBounds = bounds.clone()
			} else {
				commonBounds = commonBounds.expand(bounds)
			}
		})

		return commonBounds
	}

	/**
	 * Get the top-most selected shape at the given point, ignoring groups.
	 *
	 * @param point - The point to check.
	 *
	 * @returns The top-most selected shape at the given point, or undefined if there is no shape at the point.
	 */
	getSelectedShapeAtPoint(point: VecLike): TLShape | undefined {
		const selectedShapeIds = this.getSelectedShapeIds()
		return this.getCurrentPageShapesSorted()
			.filter((shape) => shape.type !== 'group' && selectedShapeIds.includes(shape.id))
			.reverse() // findlast
			.find((shape) => this.isPointInShape(shape, point, { hitInside: true, margin: 0 }))
	}

	/**
	 * Get the shape at the current point.
	 *
	 * @param point - The point to check.
	 * @param opts - Options for the check: `hitInside` to check if the point is inside the shape, `margin` to check if the point is within a margin of the shape, `hitFrameInside` to check if the point is inside the frame, and `filter` to filter the shapes to check.
	 *
	 * @returns The shape at the given point, or undefined if there is no shape at the point.
	 */
	getShapeAtPoint(
		point: VecLike,
		opts = {} as {
			renderingOnly?: boolean
			margin?: number
			hitInside?: boolean
			// TODO: we probably need to rename this, we don't quite _always_
			// respect this esp. in the part below that does "Check labels first"
			hitLabels?: boolean
			hitFrameInside?: boolean
			filter?: (shape: TLShape) => boolean
		}
	): TLShape | undefined {
		const zoomLevel = this.getZoomLevel()
		const viewportPageBounds = this.getViewportPageBounds()
		const {
			filter,
			margin = 0,
			hitLabels = false,
			hitInside = false,
			hitFrameInside = false,
		} = opts

		let inHollowSmallestArea = Infinity
		let inHollowSmallestAreaHit: TLShape | null = null

		let inMarginClosestToEdgeDistance = Infinity
		let inMarginClosestToEdgeHit: TLShape | null = null

		const shapesToCheck = (
			opts.renderingOnly
				? this.getCurrentPageRenderingShapesSorted()
				: this.getCurrentPageShapesSorted()
		).filter((shape) => {
			if (this.isShapeOfType(shape, 'group')) return false
			const pageMask = this.getShapeMask(shape)
			if (pageMask && !pointInPolygon(point, pageMask)) return false
			if (filter) return filter(shape)
			return true
		})
		for (let i = shapesToCheck.length - 1; i >= 0; i--) {
			const shape = shapesToCheck[i]
			const geometry = this.getShapeGeometry(shape)
			const isGroup = geometry instanceof Group2d

			const pointInShapeSpace = this.getPointInShapeSpace(shape, point)

			// Check labels first
			if (
				this.isShapeOfType<TLArrowShape>(shape, 'arrow') ||
				(this.isShapeOfType<TLGeoShape>(shape, 'geo') && shape.props.fill === 'none')
			) {
				if (shape.props.text.trim()) {
					// let's check whether the shape has a label and check that
					for (const childGeometry of (geometry as Group2d).children) {
						if (childGeometry.isLabel && childGeometry.isPointInBounds(pointInShapeSpace)) {
							return shape
						}
					}
				}
			}

			if (this.isShapeOfType(shape, 'frame')) {
				// On the rare case that we've hit a frame, test again hitInside to be forced true;
				// this prevents clicks from passing through the body of a frame to shapes behhind it.

				// If the hit is within the frame's outer margin, then select the frame
				const distance = geometry.distanceToPoint(pointInShapeSpace, hitInside)
				if (Math.abs(distance) <= margin) {
					return inMarginClosestToEdgeHit || shape
				}

				if (geometry.hitTestPoint(pointInShapeSpace, 0, true)) {
					// Once we've hit a frame, we want to end the search. If we have hit a shape
					// already, then this would either be above the frame or a child of the frame,
					// so we want to return that. Otherwise, the point is in the empty space of the
					// frame. If `hitFrameInside` is true (e.g. used drawing an arrow into the
					// frame) we the frame itself; other wise, (e.g. when hovering or pointing)
					// we would want to return null.
					return (
						inMarginClosestToEdgeHit ||
						inHollowSmallestAreaHit ||
						(hitFrameInside ? shape : undefined)
					)
				}
				continue
			}

			let distance: number

			if (isGroup) {
				let minDistance = Infinity
				for (const childGeometry of geometry.children) {
					if (childGeometry.isLabel && !hitLabels) continue

					// hit test the all of the child geometries that aren't labels
					const tDistance = childGeometry.distanceToPoint(pointInShapeSpace, hitInside)
					if (tDistance < minDistance) {
						minDistance = tDistance
					}
				}

				distance = minDistance
			} else {
				// If the margin is zero and the geometry has a very small width or height,
				// then check the actual distance. This is to prevent a bug where straight
				// lines would never pass the broad phase (point-in-bounds) check.
				if (margin === 0 && (geometry.bounds.w < 1 || geometry.bounds.h < 1)) {
					distance = geometry.distanceToPoint(pointInShapeSpace, hitInside)
				} else {
					// Broad phase
					if (geometry.bounds.containsPoint(pointInShapeSpace, margin)) {
						// Narrow phase (actual distance)
						distance = geometry.distanceToPoint(pointInShapeSpace, hitInside)
					} else {
						// Failed the broad phase, geddafugaotta'ere!
						distance = Infinity
					}
				}
			}

			if (geometry.isClosed) {
				// For closed shapes, the distance will be positive if outside of
				// the shape or negative if inside of the shape. If the distance
				// is greater than the margin, then it's a miss. Otherwise...

				if (distance <= margin) {
					if (geometry.isFilled || (isGroup && geometry.children[0].isFilled)) {
						// If the shape is filled, then it's a hit. Remember, we're
						// starting from the TOP-MOST shape in z-index order, so any
						// other hits would be occluded by the shape.
						return inMarginClosestToEdgeHit || shape
					} else {
						// If the shape is bigger than the viewport, then skip it.
						if (this.getShapePageBounds(shape)!.contains(viewportPageBounds)) continue

						// For hollow shapes...
						if (Math.abs(distance) < margin) {
							// We want to preference shapes where we're inside of the
							// shape margin; and we would want to hit the shape with the
							// edge closest to the point.
							if (Math.abs(distance) < inMarginClosestToEdgeDistance) {
								inMarginClosestToEdgeDistance = Math.abs(distance)
								inMarginClosestToEdgeHit = shape
							}
						} else if (!inMarginClosestToEdgeHit) {
							// If we're not within margin distnce to any edge, and if the
							// shape is hollow, then we want to hit the shape with the
							// smallest area. (There's a bug here with self-intersecting
							// shapes, like a closed drawing of an "8", but that's a bigger
							// problem to solve.)
							const { area } = geometry
							if (area < inHollowSmallestArea) {
								inHollowSmallestArea = area
								inHollowSmallestAreaHit = shape
							}
						}
					}
				}
			} else {
				// For open shapes (e.g. lines or draw shapes) always use the margin.
				// If the distance is less than the margin, return the shape as the hit.
				if (distance < HIT_TEST_MARGIN / zoomLevel) {
					return shape
				}
			}
		}

		// If we haven't hit any filled shapes or frames, then return either
		// the shape who we hit within the margin (and of those, the one that
		// had the shortest distance between the point and the shape edge),
		// or else the hollow shape with the smallest area—or if we didn't hit
		// any margins or any hollow shapes, then null.
		return inMarginClosestToEdgeHit || inHollowSmallestAreaHit || undefined
	}

	/**
	 * Get the shapes, if any, at a given page point.
	 *
	 * @example
	 * ```ts
	 * editor.getShapesAtPoint({ x: 100, y: 100 })
	 * editor.getShapesAtPoint({ x: 100, y: 100 }, { hitInside: true, exact: true })
	 * ```
	 *
	 * @param point - The page point to test.
	 *
	 * @public
	 */
	getShapesAtPoint(
		point: VecLike,
		opts = {} as { margin?: number; hitInside?: boolean }
	): TLShape[] {
		return this.getCurrentPageShapes().filter((shape) => this.isPointInShape(shape, point, opts))
	}

	/**
	 * Test whether a point (in the current page space) will will a shape. This method takes into account masks,
	 * such as when a shape is the child of a frame and is partially clipped by the frame.
	 *
	 * @example
	 * ```ts
	 * editor.isPointInShape({ x: 100, y: 100 }, myShape)
	 * ```
	 *
	 * @param shape - The shape to test against.
	 * @param point - The page point to test (in the current page space).
	 * @param hitInside - Whether to count as a hit if the point is inside of a closed shape.
	 *
	 * @public
	 */
	isPointInShape(
		shape: TLShape | TLShapeId,
		point: VecLike,
		opts = {} as {
			margin?: number
			hitInside?: boolean
		}
	): boolean {
		const { hitInside = false, margin = 0 } = opts
		const id = typeof shape === 'string' ? shape : shape.id
		// If the shape is masked, and if the point falls outside of that
		// mask, then it's defintely a miss—we don't need to test further.
		const pageMask = this.getShapeMask(id)
		if (pageMask && !pointInPolygon(point, pageMask)) return false

		return this.getShapeGeometry(id).hitTestPoint(
			this.getPointInShapeSpace(shape, point),
			margin,
			hitInside
		)
	}

	/**
	 * Convert a point in the current page space to a point in the local space of a shape. For example, if a
	 * shape's page point were `{ x: 100, y: 100 }`, a page point at `{ x: 110, y: 110 }` would be at
	 * `{ x: 10, y: 10 }` in the shape's local space.
	 *
	 * @example
	 * ```ts
	 * editor.getPointInShapeSpace(myShape, { x: 100, y: 100 })
	 * ```
	 *
	 * @param shape - The shape to get the point in the local space of.
	 * @param point - The page point to get in the local space of the shape.
	 *
	 * @public
	 */
	getPointInShapeSpace(shape: TLShape | TLShapeId, point: VecLike): Vec {
		const id = typeof shape === 'string' ? shape : shape.id
		return this._getShapePageTransformCache().get(id)!.clone().invert().applyToPoint(point)
	}

	/**
	 * Convert a delta in the current page space to a point in the local space of a shape's parent.
	 *
	 * @example
	 * ```ts
	 * editor.getPointInParentSpace(myShape.id, { x: 100, y: 100 })
	 * ```
	 *
	 * @param shape - The shape to get the point in the local space of.
	 * @param point - The page point to get in the local space of the shape.
	 *
	 * @public
	 */
	getPointInParentSpace(shape: TLShapeId | TLShape, point: VecLike): Vec {
		const id = typeof shape === 'string' ? shape : shape.id
		const freshShape = this.getShape(id)
		if (!freshShape) return new Vec(0, 0)
		if (isPageId(freshShape.parentId)) return Vec.From(point)

		const parentTransform = this.getShapePageTransform(freshShape.parentId)
		if (!parentTransform) return Vec.From(point)
		return parentTransform.clone().invert().applyToPoint(point)
	}

	/**
	 * An array containing all of the shapes in the current page.
	 *
	 * @public
	 */
	@computed getCurrentPageShapes(): TLShape[] {
		return Array.from(this.getCurrentPageShapeIds(), (id) => this.store.get(id)! as TLShape)
	}

	/**
	 * An array containing all of the shapes in the current page, sorted in z-index order (accounting
	 * for nested shapes): e.g. A, B, BA, BB, C.
	 *
	 * @public
	 */
	@computed getCurrentPageShapesSorted(): TLShape[] {
		const result: TLShape[] = []
		const topLevelShapes = this.getSortedChildIdsForParent(this.getCurrentPageId())

		for (let i = 0, n = topLevelShapes.length; i < n; i++) {
			pushShapeWithDescendants(this, topLevelShapes[i], result)
		}

		return result
	}

	/**
	 * An array containing all of the rendering shapes in the current page, sorted in z-index order (accounting
	 * for nested shapes): e.g. A, B, BA, BB, C.
	 *
	 * @public
	 */
	@computed getCurrentPageRenderingShapesSorted(): TLShape[] {
		const culledShapes = this.getCulledShapes()
		return this.getCurrentPageShapesSorted().filter(({ id }) => !culledShapes.has(id))
	}

	/**
	 * Get whether a shape matches the type of a TLShapeUtil.
	 *
	 * @example
	 * ```ts
	 * const isArrowShape = isShapeOfType<TLArrowShape>(someShape, 'arrow')
	 * ```
	 *
	 * @param util - the TLShapeUtil constructor to test against
	 * @param shape - the shape to test
	 *
	 * @public
	 */
	isShapeOfType<T extends TLUnknownShape>(shape: TLUnknownShape, type: T['type']): shape is T
	isShapeOfType<T extends TLUnknownShape>(
		shapeId: TLUnknownShape['id'],
		type: T['type']
	): shapeId is T['id']
	isShapeOfType<T extends TLUnknownShape>(
		arg: TLUnknownShape | TLUnknownShape['id'],
		type: T['type']
	) {
		const shape = typeof arg === 'string' ? this.getShape(arg) : arg
		if (!shape) return false
		return shape.type === type
	}

	/**
	 * Get a shape by its id.
	 *
	 * @example
	 * ```ts
	 * editor.getShape('box1')
	 * ```
	 *
	 * @param id - The id of the shape to get.
	 *
	 * @public
	 */
	getShape<T extends TLShape = TLShape>(shape: TLShape | TLParentId): T | undefined {
		const id = typeof shape === 'string' ? shape : shape.id
		if (!isShapeId(id)) return undefined
		return this.store.get(id) as T
	}

	/**
	 * Get the parent shape for a given shape. Returns undefined if the shape is the direct child of
	 * the page.
	 *
	 * @example
	 * ```ts
	 * editor.getShapeParent(myShape)
	 * ```
	 *
	 * @public
	 */
	getShapeParent(shape?: TLShape | TLShapeId): TLShape | undefined {
		const id = typeof shape === 'string' ? shape : shape?.id
		if (!id) return undefined
		const freshShape = this.getShape(id)
		if (freshShape === undefined || !isShapeId(freshShape.parentId)) return undefined
		return this.store.get(freshShape.parentId)
	}

	/**
	 * If siblingShape and targetShape are siblings, this returns targetShape. If targetShape has an
	 * ancestor who is a sibling of siblingShape, this returns that ancestor. Otherwise, this returns
	 * undefined.
	 *
	 * @internal
	 */
	private getShapeNearestSibling(
		siblingShape: TLShape,
		targetShape: TLShape | undefined
	): TLShape | undefined {
		if (!targetShape) {
			return undefined
		}
		if (targetShape.parentId === siblingShape.parentId) {
			return targetShape
		}

		const ancestor = this.findShapeAncestor(
			targetShape,
			(ancestor) => ancestor.parentId === siblingShape.parentId
		)

		return ancestor
	}

	/**
	 * Get whether the given shape is the descendant of the given page.
	 *
	 * @example
	 * ```ts
	 * editor.isShapeInPage(myShape)
	 * editor.isShapeInPage(myShape, 'page1')
	 * ```
	 *
	 * @param shape - The shape to check.
	 * @param pageId - The id of the page to check against. Defaults to the current page.
	 *
	 * @public
	 */
	isShapeInPage(shape: TLShape | TLShapeId, pageId = this.getCurrentPageId()): boolean {
		const id = typeof shape === 'string' ? shape : shape.id
		const shapeToCheck = this.getShape(id)
		if (!shapeToCheck) return false

		let shapeIsInPage = false

		if (shapeToCheck.parentId === pageId) {
			shapeIsInPage = true
		} else {
			let parent = this.getShape(shapeToCheck.parentId)
			isInPageSearch: while (parent) {
				if (parent.parentId === pageId) {
					shapeIsInPage = true
					break isInPageSearch
				}
				parent = this.getShape(parent.parentId)
			}
		}

		return shapeIsInPage
	}

	/**
	 * Get the id of the containing page for a given shape.
	 *
	 * @param shape - The shape to get the page id for.
	 *
	 * @returns The id of the page that contains the shape, or undefined if the shape is undefined.
	 *
	 * @public
	 */
	getAncestorPageId(shape?: TLShape | TLShapeId): TLPageId | undefined {
		const id = typeof shape === 'string' ? shape : shape?.id
		const _shape = id && this.getShape(id)
		if (!_shape) return undefined
		if (isPageId(_shape.parentId)) {
			return _shape.parentId
		} else {
			return this.getAncestorPageId(this.getShape(_shape.parentId))
		}
	}

	// Parents and children

	/**
	 * A cache of parents to children.
	 *
	 * @internal
	 */
	private readonly _parentIdsToChildIds: ReturnType<typeof parentsToChildren>

	/**
	 * Reparent shapes to a new parent. This operation preserves the shape's current page positions /
	 * rotations.
	 *
	 * @example
	 * ```ts
	 * editor.reparentShapes([box1, box2], 'frame1')
	 * editor.reparentShapes([box1.id, box2.id], 'frame1')
	 * editor.reparentShapes([box1.id, box2.id], 'frame1', 4)
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) of the shapes to reparent.
	 * @param parentId - The id of the new parent shape.
	 * @param insertIndex - The index to insert the children.
	 *
	 * @public
	 */
	reparentShapes(shapes: TLShapeId[] | TLShape[], parentId: TLParentId, insertIndex?: IndexKey) {
		const ids =
			typeof shapes[0] === 'string' ? (shapes as TLShapeId[]) : shapes.map((s) => (s as TLShape).id)
		if (ids.length === 0) return this

		const changes: TLShapePartial[] = []

		const parentTransform = isPageId(parentId)
			? Mat.Identity()
			: this.getShapePageTransform(parentId)!

		const parentPageRotation = parentTransform.rotation()

		let indices: IndexKey[] = []

		const sibs = compact(this.getSortedChildIdsForParent(parentId).map((id) => this.getShape(id)))

		if (insertIndex) {
			const sibWithInsertIndex = sibs.find((s) => s.index === insertIndex)
			if (sibWithInsertIndex) {
				// If there's a sibling with the same index as the insert index...
				const sibAbove = sibs[sibs.indexOf(sibWithInsertIndex) + 1]
				if (sibAbove) {
					// If the sibling has a sibling above it, insert the shapes
					// between the sibling and its sibling above it.
					indices = getIndicesBetween(insertIndex, sibAbove.index, ids.length)
				} else {
					// Or if the sibling is the top sibling, insert the shapes
					// above the sibling
					indices = getIndicesAbove(insertIndex, ids.length)
				}
			} else {
				// If there's no collision, then we can start at the insert index
				const sibAbove = sibs.sort(sortByIndex).find((s) => s.index > insertIndex)

				if (sibAbove) {
					// If the siblings include a sibling with a higher index, insert the shapes
					// between the insert index and the sibling with the higher index.
					indices = getIndicesBetween(insertIndex, sibAbove.index, ids.length)
				} else {
					// Otherwise, we're at the top of the order, so insert the shapes above
					// the insert index.
					indices = getIndicesAbove(insertIndex, ids.length)
				}
			}
		} else {
			// If insert index is not specified, start the index at the top.
			const sib = sibs.length && sibs[sibs.length - 1]
			indices = sib ? getIndicesAbove(sib.index, ids.length) : getIndices(ids.length)
		}

		const invertedParentTransform = parentTransform.clone().invert()

		const shapesToReparent = compact(ids.map((id) => this.getShape(id)))

		// The user is allowed to re-parent locked shapes. Unintutive? Yeah! But there are plenty of
		// times when a locked shape's parent is deleted... and we need to put that shape somewhere!
		const lockedShapes = shapesToReparent.filter((shape) => shape.isLocked)

		if (lockedShapes.length) {
			// If we have locked shapes, unlock them before we update them
			this.updateShapes(lockedShapes.map(({ id, type }) => ({ id, type, isLocked: false })))
		}

		for (let i = 0; i < shapesToReparent.length; i++) {
			const shape = shapesToReparent[i]

			const pageTransform = this.getShapePageTransform(shape)!
			if (!pageTransform) continue

			const pagePoint = pageTransform.point()
			if (!pagePoint) continue

			const newPoint = invertedParentTransform.applyToPoint(pagePoint)
			const newRotation = pageTransform.rotation() - parentPageRotation

			changes.push({
				id: shape.id,
				type: shape.type,
				parentId: parentId,
				x: newPoint.x,
				y: newPoint.y,
				rotation: newRotation,
				index: indices[i],
				isLocked: shape.isLocked, // this will re-lock locked shapes
			})
		}

		this.updateShapes(changes)

		return this
	}

	/**
	 * Get the index above the highest child of a given parent.
	 *
	 * @param parentId - The id of the parent.
	 *
	 * @returns The index.
	 *
	 * @public
	 */
	getHighestIndexForParent(parent: TLParentId | TLPage | TLShape): IndexKey {
		const parentId = typeof parent === 'string' ? parent : parent.id
		const children = this._parentIdsToChildIds.get()[parentId]

		if (!children || children.length === 0) {
			return 'a1' as IndexKey
		}
		const shape = this.getShape(children[children.length - 1])!
		return getIndexAbove(shape.index)
	}

	/**
	 * A cache of children for each parent.
	 *
	 * @internal
	 */
	private _childIdsCache = new WeakMapCache<any[], TLShapeId[]>()

	/**
	 * Get an array of all the children of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getSortedChildIdsForParent('frame1')
	 * ```
	 *
	 * @param parentId - The id of the parent shape.
	 *
	 * @public
	 */
	getSortedChildIdsForParent(parent: TLParentId | TLPage | TLShape): TLShapeId[] {
		const parentId = typeof parent === 'string' ? parent : parent.id
		const ids = this._parentIdsToChildIds.get()[parentId]
		if (!ids) return EMPTY_ARRAY
		return this._childIdsCache.get(ids, () => ids)
	}

	/**
	 * Run a visitor function for all descendants of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.visitDescendants('frame1', myCallback)
	 * ```
	 *
	 * @param parentId - The id of the parent shape.
	 * @param visitor - The visitor function.
	 *
	 * @public
	 */
	visitDescendants(
		parent: TLParentId | TLPage | TLShape,
		visitor: (id: TLShapeId) => void | false
	): this {
		const parentId = typeof parent === 'string' ? parent : parent.id
		const children = this.getSortedChildIdsForParent(parentId)
		for (const id of children) {
			if (visitor(id) === false) continue
			this.visitDescendants(id, visitor)
		}
		return this
	}

	/**
	 * Get the shape ids of all descendants of the given shapes (including the shapes themselves).
	 *
	 * @param ids - The ids of the shapes to get descendants of.
	 *
	 * @returns The decscendant ids.
	 *
	 * @public
	 */
	getShapeAndDescendantIds(ids: TLShapeId[]): Set<TLShapeId> {
		const idsToInclude = new Set<TLShapeId>()

		const idsToCheck = [...ids]

		while (idsToCheck.length > 0) {
			const id = idsToCheck.pop()
			if (!id) break
			if (idsToInclude.has(id)) continue
			idsToInclude.add(id)
			for (const childId of this.getSortedChildIdsForParent(id)) {
				idsToCheck.push(childId)
			}
		}

		return idsToInclude
	}

	/**
	 * Get the shape that some shapes should be dropped on at a given point.
	 *
	 * @param point - The point to find the parent for.
	 * @param droppingShapes - The shapes that are being dropped.
	 *
	 * @returns The shape to drop on.
	 *
	 * @public
	 */
	getDroppingOverShape(point: VecLike, droppingShapes: TLShape[] = []) {
		// starting from the top...
		const currentPageShapesSorted = this.getCurrentPageShapesSorted()
		for (let i = currentPageShapesSorted.length - 1; i >= 0; i--) {
			const shape = currentPageShapesSorted[i]

			if (
				// don't allow dropping on selected shapes
				this.getSelectedShapeIds().includes(shape.id) ||
				// only allow shapes that can receive children
				!this.getShapeUtil(shape).canDropShapes(shape, droppingShapes) ||
				// don't allow dropping a shape on itself or one of it's children
				droppingShapes.find((s) => s.id === shape.id || this.hasAncestor(shape, s.id))
			) {
				continue
			}

			// Only allow dropping into the masked page bounds of the shape, e.g. when a frame is
			// partially clipped by its own parent frame
			const maskedPageBounds = this.getShapeMaskedPageBounds(shape.id)

			if (
				maskedPageBounds &&
				maskedPageBounds.containsPoint(point) &&
				this.getShapeGeometry(shape).hitTestPoint(this.getPointInShapeSpace(shape, point), 0, true)
			) {
				return shape
			}
		}
	}

	/**
	 * Get the shape that should be selected when you click on a given shape, assuming there is
	 * nothing already selected. It will not return anything higher than or including the current
	 * focus layer.
	 *
	 * @param shape - The shape to get the outermost selectable shape for.
	 * @param filter - A function to filter the selectable shapes.
	 *
	 * @returns The outermost selectable shape.
	 *
	 * @public
	 */
	getOutermostSelectableShape(
		shape: TLShape | TLShapeId,
		filter?: (shape: TLShape) => boolean
	): TLShape {
		const id = typeof shape === 'string' ? shape : shape.id
		const freshShape = this.getShape(id)!
		let match = freshShape
		let node = freshShape as TLShape | undefined

		const focusedGroup = this.getFocusedGroup()

		while (node) {
			if (
				this.isShapeOfType<TLGroupShape>(node, 'group') &&
				focusedGroup?.id !== node.id &&
				!this.hasAncestor(focusedGroup, node.id) &&
				(filter?.(node) ?? true)
			) {
				match = node
			} else if (focusedGroup?.id === node.id) {
				break
			}
			node = this.getShapeParent(node)
		}

		return match
	}

	/* -------------------- Commands -------------------- */

	/**
	 * Rotate shapes by a delta in radians.
	 * Note: Currently, this assumes that the shapes are your currently selected shapes.
	 *
	 * @example
	 * ```ts
	 * editor.rotateShapesBy(editor.getSelectedShapeIds(), Math.PI)
	 * editor.rotateShapesBy(editor.getSelectedShapeIds(), Math.PI / 2)
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) of the shapes to move.
	 * @param delta - The delta in radians to apply to the selection rotation.
	 */
	rotateShapesBy(shapes: TLShapeId[] | TLShape[], delta: number): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)

		if (ids.length <= 0) return this

		const snapshot = getRotationSnapshot({ editor: this })
		if (!snapshot) return this
		applyRotationToSnapshotShapes({ delta, snapshot, editor: this, stage: 'one-off' })

		return this
	}

	private getChangesToTranslateShape(initialShape: TLShape, newShapeCoords: VecLike): TLShape {
		let workingShape = initialShape
		const util = this.getShapeUtil(initialShape)

		workingShape = applyPartialToShape(
			workingShape,
			util.onTranslateStart?.(workingShape) ?? undefined
		)

		workingShape = applyPartialToShape(workingShape, {
			id: initialShape.id,
			type: initialShape.type,
			x: newShapeCoords.x,
			y: newShapeCoords.y,
		})

		workingShape = applyPartialToShape(
			workingShape,
			util.onTranslate?.(initialShape, workingShape) ?? undefined
		)

		workingShape = applyPartialToShape(
			workingShape,
			util.onTranslateEnd?.(initialShape, workingShape) ?? undefined
		)

		return workingShape
	}

	/**
	 * Move shapes by a delta.
	 *
	 * @example
	 * ```ts
	 * editor.nudgeShapes(['box1', 'box2'], { x: 8, y: 8 })
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) to move.
	 * @param direction - The direction in which to move the shapes.
	 * @param historyOptions - The history options for the change.
	 */
	nudgeShapes(shapes: TLShapeId[] | TLShape[], offset: VecLike): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)

		if (ids.length <= 0) return this
		const changes: TLShapePartial[] = []

		for (const id of ids) {
			const shape = this.getShape(id)!
			const localDelta = Vec.From(offset)
			const parentTransform = this.getShapeParentTransform(shape)
			if (parentTransform) localDelta.rot(-parentTransform.rotation())

			changes.push(this.getChangesToTranslateShape(shape, localDelta.add(shape)))
		}

		this.updateShapes(changes)

		return this
	}

	/**
	 * Duplicate shapes.
	 *
	 * @example
	 * ```ts
	 * editor.duplicateShapes(['box1', 'box2'], { x: 8, y: 8 })
	 * editor.duplicateShapes(editor.getSelectedShapes(), { x: 8, y: 8 })
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) to duplicate.
	 * @param offset - The offset (in pixels) to apply to the duplicated shapes.
	 *
	 * @public
	 */
	duplicateShapes(shapes: TLShapeId[] | TLShape[], offset?: VecLike): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)

		if (ids.length <= 0) return this

		const initialIds = new Set(ids)
		const idsToCreate: TLShapeId[] = []
		const idsToCheck = [...ids]

		while (idsToCheck.length > 0) {
			const id = idsToCheck.pop()
			if (!id) break
			idsToCreate.push(id)
			this.getSortedChildIdsForParent(id).forEach((childId) => idsToCheck.push(childId))
		}

		idsToCreate.reverse()

		const idsMap = new Map<any, TLShapeId>(idsToCreate.map((id) => [id, createShapeId()]))

		const shapesToCreate = compact(
			idsToCreate.map((id) => {
				const shape = this.getShape(id)

				if (!shape) {
					return null
				}

				const createId = idsMap.get(id)!

				let ox = 0
				let oy = 0

				if (offset && initialIds.has(id)) {
					const parentTransform = this.getShapeParentTransform(shape)
					const vec = new Vec(offset.x, offset.y).rot(-parentTransform!.rotation())
					ox = vec.x
					oy = vec.y
				}

				const parentId = shape.parentId ?? this.getCurrentPageId()
				const siblings = this.getSortedChildIdsForParent(parentId)
				const currentIndex = siblings.indexOf(shape.id)
				const siblingAboveId = siblings[currentIndex + 1]
				const siblingAbove = siblingAboveId ? this.getShape(siblingAboveId) : null

				const index = siblingAbove
					? getIndexBetween(shape.index, siblingAbove.index)
					: getIndexAbove(shape.index)

				let newShape: TLShape = structuredClone(shape)

				if (
					this.isShapeOfType<TLArrowShape>(shape, 'arrow') &&
					this.isShapeOfType<TLArrowShape>(newShape, 'arrow')
				) {
					const info = this.getArrowInfo(shape)
					let newStartShapeId: TLShapeId | undefined = undefined
					let newEndShapeId: TLShapeId | undefined = undefined

					if (shape.props.start.type === 'binding') {
						newStartShapeId = idsMap.get(shape.props.start.boundShapeId)

						if (!newStartShapeId) {
							if (info?.isValid) {
								const { x, y } = info.start.point
								newShape.props.start = {
									type: 'point',
									x,
									y,
								}
							} else {
								const { start } = getArrowTerminalsInArrowSpace(this, shape)
								newShape.props.start = {
									type: 'point',
									x: start.x,
									y: start.y,
								}
							}
						}
					}

					if (shape.props.end.type === 'binding') {
						newEndShapeId = idsMap.get(shape.props.end.boundShapeId)
						if (!newEndShapeId) {
							if (info?.isValid) {
								const { x, y } = info.end.point
								newShape.props.end = {
									type: 'point',
									x,
									y,
								}
							} else {
								const { end } = getArrowTerminalsInArrowSpace(this, shape)
								newShape.props.start = {
									type: 'point',
									x: end.x,
									y: end.y,
								}
							}
						}
					}

					const infoAfter = getIsArrowStraight(newShape)
						? getStraightArrowInfo(this, newShape)
						: getCurvedArrowInfo(this, newShape)

					if (info?.isValid && infoAfter?.isValid && !getIsArrowStraight(shape)) {
						const mpA = Vec.Med(info.start.handle, info.end.handle)
						const distA = Vec.Dist(info.middle, mpA)
						const distB = Vec.Dist(infoAfter.middle, mpA)
						if (newShape.props.bend < 0) {
							newShape.props.bend += distB - distA
						} else {
							newShape.props.bend -= distB - distA
						}
					}

					if (newShape.props.start.type === 'binding' && newStartShapeId) {
						newShape.props.start.boundShapeId = newStartShapeId
					}

					if (newShape.props.end.type === 'binding' && newEndShapeId) {
						newShape.props.end.boundShapeId = newEndShapeId
					}
				}

				newShape = { ...newShape, id: createId, x: shape.x + ox, y: shape.y + oy, index }

				return newShape
			})
		)

		shapesToCreate.forEach((shape) => {
			if (isShapeId(shape.parentId)) {
				if (idsMap.has(shape.parentId)) {
					shape.parentId = idsMap.get(shape.parentId)!
				}
			}
		})

		this.history.batch(() => {
			const maxShapesReached =
				shapesToCreate.length + this.getCurrentPageShapeIds().size > MAX_SHAPES_PER_PAGE

			if (maxShapesReached) {
				alertMaxShapes(this)
			}

			const newShapes = maxShapesReached
				? shapesToCreate.slice(0, MAX_SHAPES_PER_PAGE - this.getCurrentPageShapeIds().size)
				: shapesToCreate

			const ids = newShapes.map((s) => s.id)

			this.createShapes(newShapes)
			this.setSelectedShapes(ids)

			if (offset !== undefined) {
				// If we've offset the duplicated shapes, check to see whether their new bounds is entirely
				// contained in the current viewport. If not, then animate the camera to be centered on the
				// new shapes.
				const selectionPageBounds = this.getSelectionPageBounds()
				const viewportPageBounds = this.getViewportPageBounds()
				if (selectionPageBounds && !viewportPageBounds.contains(selectionPageBounds)) {
					this.centerOnPoint(selectionPageBounds.center, {
						duration: ANIMATION_MEDIUM_MS,
					})
				}
			}
		})

		return this
	}

	/**
	 * Move shapes to page.
	 *
	 * @example
	 * ```ts
	 * editor.moveShapesToPage(['box1', 'box2'], 'page1')
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) of the shapes to move.
	 * @param pageId - The id of the page where the shapes will be moved.
	 *
	 * @public
	 */
	moveShapesToPage(shapes: TLShapeId[] | TLShape[], pageId: TLPageId): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)

		if (ids.length === 0) return this
		if (this.getInstanceState().isReadonly) return this

		const currentPageId = this.getCurrentPageId()

		if (pageId === currentPageId) return this
		if (!this.store.has(pageId)) return this

		// Basically copy the shapes
		const content = this.getContentFromCurrentPage(ids)

		// Just to be sure
		if (!content) return this

		// If there is no space on pageId, or if the selected shapes
		// would take the new page above the limit, don't move the shapes
		if (this.getPageShapeIds(pageId).size + content.shapes.length > MAX_SHAPES_PER_PAGE) {
			alertMaxShapes(this, pageId)
			return this
		}

		const fromPageZ = this.getCamera().z

		this.history.batch(() => {
			// Delete the shapes on the current page
			this.deleteShapes(ids)

			// Move to the next page
			this.setCurrentPage(pageId)

			// Put the shape content onto the new page; parents and indices will
			// be taken care of by the putContent method; make sure to pop any focus
			// layers so that the content will be put onto the page.
			this.setFocusedGroup(null)
			this.selectNone()
			this.putContentOntoCurrentPage(content, {
				select: true,
				preserveIds: true,
				preservePosition: true,
			})

			// Force the new page's camera to be at the same zoom level as the
			// "from" page's camera, then center the "to" page's camera on the
			// pasted shapes
			this.setCamera({ ...this.getCamera(), z: fromPageZ })
			this.centerOnPoint(this.getSelectionRotatedPageBounds()!.center)
		})

		return this
	}

	/**
	 * Toggle the lock state of one or more shapes. If there is a mix of locked and unlocked shapes, all shapes will be locked.
	 *
	 * @param shapes - The shapes (or shape ids) to toggle.
	 *
	 * @public
	 */
	toggleLock(shapes: TLShapeId[] | TLShape[]): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)

		if (this.getInstanceState().isReadonly || ids.length === 0) return this

		let allLocked = true,
			allUnlocked = true
		const shapesToToggle: TLShape[] = []
		for (const id of ids) {
			const shape = this.getShape(id)
			if (shape) {
				shapesToToggle.push(shape)
				if (shape.isLocked) {
					allUnlocked = false
				} else {
					allLocked = false
				}
			}
		}
		this.batch(() => {
			if (allUnlocked) {
				this.updateShapes(
					shapesToToggle.map((shape) => ({ id: shape.id, type: shape.type, isLocked: true }))
				)
				this.setSelectedShapes([])
			} else if (allLocked) {
				this.updateShapes(
					shapesToToggle.map((shape) => ({ id: shape.id, type: shape.type, isLocked: false }))
				)
			} else {
				this.updateShapes(
					shapesToToggle.map((shape) => ({ id: shape.id, type: shape.type, isLocked: true }))
				)
			}
		})

		return this
	}

	/**
	 * Send shapes to the back of the page's object list.
	 *
	 * @example
	 * ```ts
	 * editor.sendToBack(['id1', 'id2'])
	 * editor.sendToBack(box1, box2)
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) to move.
	 *
	 * @public
	 */
	sendToBack(shapes: TLShapeId[] | TLShape[]): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)
		const changes = getReorderingShapesChanges(this, 'toBack', ids as TLShapeId[])
		if (changes) this.updateShapes(changes)
		return this
	}

	/**
	 * Send shapes backward in the page's object list.
	 *
	 * @example
	 * ```ts
	 * editor.sendBackward(['id1', 'id2'])
	 * editor.sendBackward([box1, box2])
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) to move.
	 *
	 * @public
	 */
	sendBackward(shapes: TLShapeId[] | TLShape[]): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)
		const changes = getReorderingShapesChanges(this, 'backward', ids as TLShapeId[])
		if (changes) this.updateShapes(changes)
		return this
	}

	/**
	 * Bring shapes forward in the page's object list.
	 *
	 * @example
	 * ```ts
	 * editor.bringForward(['id1', 'id2'])
	 * editor.bringForward(box1,  box2)
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) to move.
	 *
	 * @public
	 */
	bringForward(shapes: TLShapeId[] | TLShape[]): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)
		const changes = getReorderingShapesChanges(this, 'forward', ids as TLShapeId[])
		if (changes) this.updateShapes(changes)
		return this
	}

	/**
	 * Bring shapes to the front of the page's object list.
	 *
	 * @example
	 * ```ts
	 * editor.bringToFront(['id1', 'id2'])
	 * editor.bringToFront([box1, box2])
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) to move.
	 *
	 * @public
	 */
	bringToFront(shapes: TLShapeId[] | TLShape[]): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)
		const changes = getReorderingShapesChanges(this, 'toFront', ids as TLShapeId[])
		if (changes) this.updateShapes(changes)
		return this
	}

	/**
	 * Flip shape positions.
	 *
	 * @example
	 * ```ts
	 * editor.flipShapes([box1, box2], 'horizontal', 32)
	 * editor.flipShapes(editor.getSelectedShapeIds(), 'horizontal', 32)
	 * ```
	 *
	 * @param shapes - The ids of the shapes to flip.
	 * @param operation - Whether to flip horizontally or vertically.
	 *
	 * @public
	 */
	flipShapes(shapes: TLShapeId[] | TLShape[], operation: 'horizontal' | 'vertical'): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)

		if (this.getInstanceState().isReadonly) return this

		let shapesToFlip = compact(ids.map((id) => this.getShape(id)))

		if (!shapesToFlip.length) return this

		shapesToFlip = compact(
			shapesToFlip
				.map((shape) => {
					if (this.isShapeOfType<TLGroupShape>(shape, 'group')) {
						return this.getSortedChildIdsForParent(shape.id).map((id) => this.getShape(id))
					}

					return shape
				})
				.flat()
		)

		const scaleOriginPage = Box.Common(
			compact(shapesToFlip.map((id) => this.getShapePageBounds(id)))
		).center

		this.batch(() => {
			for (const shape of shapesToFlip) {
				const bounds = this.getShapeGeometry(shape).bounds
				const initialPageTransform = this.getShapePageTransform(shape.id)
				if (!initialPageTransform) continue
				this.resizeShape(
					shape.id,
					{ x: operation === 'horizontal' ? -1 : 1, y: operation === 'vertical' ? -1 : 1 },
					{
						initialBounds: bounds,
						initialPageTransform,
						initialShape: shape,
						mode: 'scale_shape',
						scaleOrigin: scaleOriginPage,
						scaleAxisRotation: 0,
					}
				)
			}
		})

		return this
	}

	/**
	 * Stack shape.
	 *
	 * @example
	 * ```ts
	 * editor.stackShapes([box1, box2], 'horizontal', 32)
	 * editor.stackShapes(editor.getSelectedShapeIds(), 'horizontal', 32)
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) to stack.
	 * @param operation - Whether to stack horizontally or vertically.
	 * @param gap - The gap to leave between shapes.
	 *
	 * @public
	 */
	stackShapes(
		shapes: TLShapeId[] | TLShape[],
		operation: 'horizontal' | 'vertical',
		gap: number
	): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)
		if (this.getInstanceState().isReadonly) return this

		const shapesToStack = compact(
			ids
				.map((id) => this.getShape(id)) // always fresh shapes
				.filter((shape) => {
					if (!shape) return false

					if (this.isShapeOfType<TLArrowShape>(shape, 'arrow')) {
						if (shape.props.start.type === 'binding' || shape.props.end.type === 'binding') {
							return false
						}
					}

					return true
				})
		)

		const len = shapesToStack.length

		if ((gap === 0 && len < 3) || len < 2) return this

		const pageBounds = Object.fromEntries(
			shapesToStack.map((shape) => [shape.id, this.getShapePageBounds(shape)!])
		)

		let val: 'x' | 'y'
		let min: 'minX' | 'minY'
		let max: 'maxX' | 'maxY'
		let dim: 'width' | 'height'

		if (operation === 'horizontal') {
			val = 'x'
			min = 'minX'
			max = 'maxX'
			dim = 'width'
		} else {
			val = 'y'
			min = 'minY'
			max = 'maxY'
			dim = 'height'
		}

		let shapeGap: number

		if (gap === 0) {
			const gaps: { gap: number; count: number }[] = []

			shapesToStack.sort((a, b) => pageBounds[a.id][min] - pageBounds[b.id][min])

			// Collect all of the gaps between shapes. We want to find
			// patterns (equal gaps between shapes) and use the most common
			// one as the gap for all of the shapes.
			for (let i = 0; i < len - 1; i++) {
				const shape = shapesToStack[i]
				const nextShape = shapesToStack[i + 1]

				const bounds = pageBounds[shape.id]
				const nextBounds = pageBounds[nextShape.id]

				const gap = nextBounds[min] - bounds[max]

				const current = gaps.find((g) => g.gap === gap)

				if (current) {
					current.count++
				} else {
					gaps.push({ gap, count: 1 })
				}
			}

			// Which gap is the most common?
			let maxCount = 0
			gaps.forEach((g) => {
				if (g.count > maxCount) {
					maxCount = g.count
					shapeGap = g.gap
				}
			})

			// If there is no most-common gap, use the average gap.
			if (maxCount === 1) {
				shapeGap = Math.max(0, gaps.reduce((a, c) => a + c.gap * c.count, 0) / (len - 1))
			}
		} else {
			// If a gap was provided, then use that instead.
			shapeGap = gap
		}

		const changes: TLShapePartial[] = []

		let v = pageBounds[shapesToStack[0].id][max]

		shapesToStack.forEach((shape, i) => {
			if (i === 0) return

			const delta = { x: 0, y: 0 }
			delta[val] = v + shapeGap - pageBounds[shape.id][val]

			const parent = this.getShapeParent(shape)
			const localDelta = parent
				? Vec.Rot(delta, -this.getShapePageTransform(parent)!.decompose().rotation)
				: delta

			const translateStartChanges = this.getShapeUtil(shape).onTranslateStart?.(shape)

			changes.push(
				translateStartChanges
					? {
							...translateStartChanges,
							[val]: shape[val] + localDelta[val],
						}
					: {
							id: shape.id as any,
							type: shape.type,
							[val]: shape[val] + localDelta[val],
						}
			)

			v += pageBounds[shape.id][dim] + shapeGap
		})

		this.updateShapes(changes)
		return this
	}

	/**
	 * Pack shapes into a grid centered on their current position. Based on potpack (https://github.com/mapbox/potpack).
	 *
	 * @example
	 * ```ts
	 * editor.packShapes([box1, box2], 32)
	 * editor.packShapes(editor.getSelectedShapeIds(), 32)
	 * ```
	 *
	 *
	 * @param shapes - The shapes (or shape ids) to pack.
	 * @param gap - The padding to apply to the packed shapes. Defaults to 16.
	 */
	packShapes(shapes: TLShapeId[] | TLShape[], gap: number): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)

		if (this.getInstanceState().isReadonly) return this
		if (ids.length < 2) return this

		const shapesToPack = compact(
			ids
				.map((id) => this.getShape(id)) // always fresh shapes
				.filter((shape) => {
					if (!shape) return false

					if (this.isShapeOfType<TLArrowShape>(shape, 'arrow')) {
						if (shape.props.start.type === 'binding' || shape.props.end.type === 'binding') {
							return false
						}
					}

					return true
				})
		)
		const shapePageBounds: Record<string, Box> = {}
		const nextShapePageBounds: Record<string, Box> = {}

		let shape: TLShape,
			bounds: Box,
			area = 0

		for (let i = 0; i < shapesToPack.length; i++) {
			shape = shapesToPack[i]
			bounds = this.getShapePageBounds(shape)!
			shapePageBounds[shape.id] = bounds
			nextShapePageBounds[shape.id] = bounds.clone()
			area += bounds.width * bounds.height
		}

		const commonBounds = Box.Common(compact(Object.values(shapePageBounds)))

		const maxWidth = commonBounds.width

		// sort the shapes by height, descending
		shapesToPack.sort((a, b) => shapePageBounds[b.id].height - shapePageBounds[a.id].height)

		// Start with is (sort of) the square of the area
		const startWidth = Math.max(Math.ceil(Math.sqrt(area / 0.95)), maxWidth)

		// first shape fills the width and is infinitely tall
		const spaces: Box[] = [new Box(commonBounds.x, commonBounds.y, startWidth, Infinity)]

		let width = 0
		let height = 0
		let space: Box
		let last: Box

		for (let i = 0; i < shapesToPack.length; i++) {
			shape = shapesToPack[i]
			bounds = nextShapePageBounds[shape.id]

			// starting at the back (smaller shapes)
			for (let i = spaces.length - 1; i >= 0; i--) {
				space = spaces[i]

				// find a space that is big enough to contain the shape
				if (bounds.width > space.width || bounds.height > space.height) continue

				// add the shape to its top-left corner
				bounds.x = space.x
				bounds.y = space.y

				height = Math.max(height, bounds.maxY)
				width = Math.max(width, bounds.maxX)

				if (bounds.width === space.width && bounds.height === space.height) {
					// remove the space on a perfect fit
					last = spaces.pop()!
					if (i < spaces.length) spaces[i] = last
				} else if (bounds.height === space.height) {
					// fit the shape into the space (width)
					space.x += bounds.width + gap
					space.width -= bounds.width + gap
				} else if (bounds.width === space.width) {
					// fit the shape into the space (height)
					space.y += bounds.height + gap
					space.height -= bounds.height + gap
				} else {
					// split the space into two spaces
					spaces.push(
						new Box(
							space.x + (bounds.width + gap),
							space.y,
							space.width - (bounds.width + gap),
							bounds.height
						)
					)
					space.y += bounds.height + gap
					space.height -= bounds.height + gap
				}
				break
			}
		}

		const commonAfter = Box.Common(Object.values(nextShapePageBounds))
		const centerDelta = Vec.Sub(commonBounds.center, commonAfter.center)

		let nextBounds: Box

		const changes: TLShapePartial<any>[] = []

		for (let i = 0; i < shapesToPack.length; i++) {
			shape = shapesToPack[i]
			bounds = shapePageBounds[shape.id]
			nextBounds = nextShapePageBounds[shape.id]

			const delta = Vec.Sub(nextBounds.point, bounds.point).add(centerDelta)
			const parentTransform = this.getShapeParentTransform(shape)
			if (parentTransform) delta.rot(-parentTransform.rotation())

			const change: TLShapePartial = {
				id: shape.id,
				type: shape.type,
				x: shape.x + delta.x,
				y: shape.y + delta.y,
			}

			const translateStartChange = this.getShapeUtil(shape).onTranslateStart?.({
				...shape,
				...change,
			})

			if (translateStartChange) {
				changes.push({ ...change, ...translateStartChange })
			} else {
				changes.push(change)
			}
		}

		if (changes.length) {
			this.updateShapes(changes)
		}

		return this
	}

	/**
	 * Align shape positions.
	 *
	 * @example
	 * ```ts
	 * editor.alignShapes([box1, box2], 'left')
	 * editor.alignShapes(editor.getSelectedShapeIds(), 'left')
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) to align.
	 * @param operation - The align operation to apply.
	 *
	 * @public
	 */

	alignShapes(
		shapes: TLShapeId[] | TLShape[],
		operation: 'left' | 'center-horizontal' | 'right' | 'top' | 'center-vertical' | 'bottom'
	): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)

		if (this.getInstanceState().isReadonly) return this
		if (ids.length < 2) return this

		const shapesToAlign = compact(ids.map((id) => this.getShape(id))) // always fresh shapes
		const shapePageBounds = Object.fromEntries(
			shapesToAlign.map((shape) => [shape.id, this.getShapePageBounds(shape)])
		)
		const commonBounds = Box.Common(compact(Object.values(shapePageBounds)))

		const changes: TLShapePartial[] = []

		shapesToAlign.forEach((shape) => {
			const pageBounds = shapePageBounds[shape.id]
			if (!pageBounds) return

			const delta = { x: 0, y: 0 }

			switch (operation) {
				case 'top': {
					delta.y = commonBounds.minY - pageBounds.minY
					break
				}
				case 'center-vertical': {
					delta.y = commonBounds.midY - pageBounds.minY - pageBounds.height / 2
					break
				}
				case 'bottom': {
					delta.y = commonBounds.maxY - pageBounds.minY - pageBounds.height
					break
				}
				case 'left': {
					delta.x = commonBounds.minX - pageBounds.minX
					break
				}
				case 'center-horizontal': {
					delta.x = commonBounds.midX - pageBounds.minX - pageBounds.width / 2
					break
				}
				case 'right': {
					delta.x = commonBounds.maxX - pageBounds.minX - pageBounds.width
					break
				}
			}

			const parent = this.getShapeParent(shape)
			const localDelta = parent
				? Vec.Rot(delta, -this.getShapePageTransform(parent)!.decompose().rotation)
				: delta

			changes.push(this.getChangesToTranslateShape(shape, Vec.Add(shape, localDelta)))
		})

		this.updateShapes(changes)
		return this
	}

	/**
	 * Distribute shape positions.
	 *
	 * @example
	 * ```ts
	 * editor.distributeShapes([box1, box2], 'horizontal')
	 * editor.distributeShapes(editor.getSelectedShapeIds(), 'horizontal')
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) to distribute.
	 * @param operation - Whether to distribute shapes horizontally or vertically.
	 *
	 * @public
	 */
	distributeShapes(shapes: TLShapeId[] | TLShape[], operation: 'horizontal' | 'vertical'): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)

		if (this.getInstanceState().isReadonly) return this
		if (ids.length < 3) return this

		const len = ids.length
		const shapesToDistribute = compact(ids.map((id) => this.getShape(id))) // always fresh shapes
		const pageBounds = Object.fromEntries(
			shapesToDistribute.map((shape) => [shape.id, this.getShapePageBounds(shape)!])
		)

		let val: 'x' | 'y'
		let min: 'minX' | 'minY'
		let max: 'maxX' | 'maxY'
		let mid: 'midX' | 'midY'
		let dim: 'width' | 'height'

		if (operation === 'horizontal') {
			val = 'x'
			min = 'minX'
			max = 'maxX'
			mid = 'midX'
			dim = 'width'
		} else {
			val = 'y'
			min = 'minY'
			max = 'maxY'
			mid = 'midY'
			dim = 'height'
		}
		const changes: TLShapePartial[] = []

		// Clustered
		const first = shapesToDistribute.sort(
			(a, b) => pageBounds[a.id][min] - pageBounds[b.id][min]
		)[0]
		const last = shapesToDistribute.sort((a, b) => pageBounds[b.id][max] - pageBounds[a.id][max])[0]

		const midFirst = pageBounds[first.id][mid]
		const step = (pageBounds[last.id][mid] - midFirst) / (len - 1)
		const v = midFirst + step

		shapesToDistribute
			.filter((shape) => shape !== first && shape !== last)
			.sort((a, b) => pageBounds[a.id][mid] - pageBounds[b.id][mid])
			.forEach((shape, i) => {
				const delta = { x: 0, y: 0 }
				delta[val] = v + step * i - pageBounds[shape.id][dim] / 2 - pageBounds[shape.id][val]

				const parent = this.getShapeParent(shape)
				const localDelta = parent
					? Vec.Rot(delta, -this.getShapePageTransform(parent)!.rotation())
					: delta

				changes.push(this.getChangesToTranslateShape(shape, Vec.Add(shape, localDelta)))
			})

		this.updateShapes(changes)
		return this
	}

	/**
	 * Stretch shape sizes and positions to fill their common bounding box.
	 *
	 * @example
	 * ```ts
	 * editor.stretchShapes([box1, box2], 'horizontal')
	 * editor.stretchShapes(editor.getSelectedShapeIds(), 'horizontal')
	 * ```
	 *
	 * @param shapes - The shapes (or shape ids) to stretch.
	 * @param operation - Whether to stretch shapes horizontally or vertically.
	 *
	 * @public
	 */
	stretchShapes(shapes: TLShapeId[] | TLShape[], operation: 'horizontal' | 'vertical'): this {
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)

		if (this.getInstanceState().isReadonly) return this
		if (ids.length < 2) return this

		const shapesToStretch = compact(ids.map((id) => this.getShape(id))) // always fresh shapes
		const shapeBounds = Object.fromEntries(ids.map((id) => [id, this.getShapeGeometry(id).bounds]))
		const shapePageBounds = Object.fromEntries(ids.map((id) => [id, this.getShapePageBounds(id)!]))
		const commonBounds = Box.Common(compact(Object.values(shapePageBounds)))

		switch (operation) {
			case 'vertical': {
				this.batch(() => {
					for (const shape of shapesToStretch) {
						const pageRotation = this.getShapePageTransform(shape)!.rotation()
						if (pageRotation % PI2) continue
						const bounds = shapeBounds[shape.id]
						const pageBounds = shapePageBounds[shape.id]
						const localOffset = new Vec(0, commonBounds.minY - pageBounds.minY)
						const parentTransform = this.getShapeParentTransform(shape)
						if (parentTransform) localOffset.rot(-parentTransform.rotation())

						const { x, y } = Vec.Add(localOffset, shape)
						this.updateShapes([{ id: shape.id, type: shape.type, x, y }])
						const scale = new Vec(1, commonBounds.height / pageBounds.height)
						this.resizeShape(shape.id, scale, {
							initialBounds: bounds,
							scaleOrigin: new Vec(pageBounds.center.x, commonBounds.minY),
							scaleAxisRotation: 0,
						})
					}
				})
				break
			}
			case 'horizontal': {
				this.batch(() => {
					for (const shape of shapesToStretch) {
						const bounds = shapeBounds[shape.id]
						const pageBounds = shapePageBounds[shape.id]
						const pageRotation = this.getShapePageTransform(shape)!.rotation()
						if (pageRotation % PI2) continue
						const localOffset = new Vec(commonBounds.minX - pageBounds.minX, 0)
						const parentTransform = this.getShapeParentTransform(shape)
						if (parentTransform) localOffset.rot(-parentTransform.rotation())

						const { x, y } = Vec.Add(localOffset, shape)
						this.updateShapes([{ id: shape.id, type: shape.type, x, y }])
						const scale = new Vec(commonBounds.width / pageBounds.width, 1)
						this.resizeShape(shape.id, scale, {
							initialBounds: bounds,
							scaleOrigin: new Vec(commonBounds.minX, pageBounds.center.y),
							scaleAxisRotation: 0,
						})
					}
				})

				break
			}
		}

		return this
	}

	/**
	 * Resize a shape.
	 *
	 * @param id - The id of the shape to resize.
	 * @param scale - The scale factor to apply to the shape.
	 * @param options - Additional options.
	 *
	 * @public
	 */
	resizeShape(
		shape: TLShapeId | TLShape,
		scale: VecLike,
		options: TLResizeShapeOptions = {}
	): this {
		const id = typeof shape === 'string' ? shape : shape.id
		if (this.getInstanceState().isReadonly) return this

		if (!Number.isFinite(scale.x)) scale = new Vec(1, scale.y)
		if (!Number.isFinite(scale.y)) scale = new Vec(scale.x, 1)

		const initialShape = options.initialShape ?? this.getShape(id)
		if (!initialShape) return this

		const scaleOrigin = options.scaleOrigin ?? this.getShapePageBounds(id)?.center
		if (!scaleOrigin) return this

		const pageTransform = options.initialPageTransform
			? Mat.Cast(options.initialPageTransform)
			: this.getShapePageTransform(id)
		if (!pageTransform) return this

		const pageRotation = pageTransform.rotation()

		if (pageRotation == null) return this

		const scaleAxisRotation = options.scaleAxisRotation ?? pageRotation

		const initialBounds = options.initialBounds ?? this.getShapeGeometry(id).bounds

		if (!initialBounds) return this

		if (!areAnglesCompatible(pageRotation, scaleAxisRotation)) {
			// shape is awkwardly rotated, keep the aspect ratio locked and adopt the scale factor
			// from whichever axis is being scaled the least, to avoid the shape getting bigger
			// than the bounds of the selection
			// const minScale = Math.min(Math.abs(scale.x), Math.abs(scale.y))
			return this._resizeUnalignedShape(id, scale, {
				...options,
				initialBounds,
				scaleOrigin,
				scaleAxisRotation,
				initialPageTransform: pageTransform,
				initialShape,
			})
		}

		const util = this.getShapeUtil(initialShape)

		if (util.isAspectRatioLocked(initialShape)) {
			if (Math.abs(scale.x) > Math.abs(scale.y)) {
				scale = new Vec(scale.x, Math.sign(scale.y) * Math.abs(scale.x))
			} else {
				scale = new Vec(Math.sign(scale.x) * Math.abs(scale.y), scale.y)
			}
		}

		if (util.onResize && util.canResize(initialShape)) {
			// get the model changes from the shape util
			const newPagePoint = this._scalePagePoint(
				Mat.applyToPoint(pageTransform, new Vec(0, 0)),
				scaleOrigin,
				scale,
				scaleAxisRotation
			)

			const newLocalPoint = this.getPointInParentSpace(initialShape.id, newPagePoint)

			// resize the shape's local bounding box
			const myScale = new Vec(scale.x, scale.y)
			// the shape is aligned with the rest of the shapes in the selection, but may be
			// 90deg offset from the main rotation of the selection, in which case
			// we need to flip the width and height scale factors
			const areWidthAndHeightAlignedWithCorrectAxis = approximately(
				(pageRotation - scaleAxisRotation) % Math.PI,
				0
			)
			myScale.x = areWidthAndHeightAlignedWithCorrectAxis ? scale.x : scale.y
			myScale.y = areWidthAndHeightAlignedWithCorrectAxis ? scale.y : scale.x

			// adjust initial model for situations where the parent has moved during the resize
			// e.g. groups
			const initialPagePoint = Mat.applyToPoint(pageTransform, new Vec())

			// need to adjust the shape's x and y points in case the parent has moved since start of resizing
			const { x, y } = this.getPointInParentSpace(initialShape.id, initialPagePoint)

			this.updateShapes([
				{
					id,
					type: initialShape.type as any,
					x: newLocalPoint.x,
					y: newLocalPoint.y,
					...util.onResize(
						{ ...initialShape, x, y },
						{
							newPoint: newLocalPoint,
							handle: options.dragHandle ?? 'bottom_right',
							// don't set isSingle to true for children
							mode: options.mode ?? 'scale_shape',
							scaleX: myScale.x,
							scaleY: myScale.y,
							initialBounds,
							initialShape,
						}
					),
				},
			])
		} else {
			const initialPageCenter = Mat.applyToPoint(pageTransform, initialBounds.center)
			// get the model changes from the shape util
			const newPageCenter = this._scalePagePoint(
				initialPageCenter,
				scaleOrigin,
				scale,
				scaleAxisRotation
			)

			const initialPageCenterInParentSpace = this.getPointInParentSpace(
				initialShape.id,
				initialPageCenter
			)
			const newPageCenterInParentSpace = this.getPointInParentSpace(initialShape.id, newPageCenter)

			const delta = Vec.Sub(newPageCenterInParentSpace, initialPageCenterInParentSpace)
			// apply the changes to the model
			this.updateShapes([
				{
					id,
					type: initialShape.type as any,
					x: initialShape.x + delta.x,
					y: initialShape.y + delta.y,
				},
			])
		}

		return this
	}

	/** @internal */
	private _scalePagePoint(
		point: VecLike,
		scaleOrigin: VecLike,
		scale: VecLike,
		scaleAxisRotation: number
	) {
		const relativePoint = Vec.RotWith(point, scaleOrigin, -scaleAxisRotation).sub(scaleOrigin)

		// calculate the new point position relative to the scale origin
		const newRelativePagePoint = Vec.MulV(relativePoint, scale)

		// and rotate it back to page coords to get the new page point of the resized shape
		const destination = Vec.Add(newRelativePagePoint, scaleOrigin).rotWith(
			scaleOrigin,
			scaleAxisRotation
		)

		return destination
	}

	/** @internal */
	private _resizeUnalignedShape(
		id: TLShapeId,
		scale: VecLike,
		options: {
			initialBounds: Box
			scaleOrigin: VecLike
			scaleAxisRotation: number
			initialShape: TLShape
			initialPageTransform: MatLike
		}
	) {
		const { type } = options.initialShape
		// If a shape is not aligned with the scale axis we need to treat it differently to avoid skewing.
		// Instead of skewing we normalize the scale aspect ratio (i.e. keep the same scale magnitude in both axes)
		// and then after applying the scale to the shape we also rotate it if required and translate it so that it's center
		// point ends up in the right place.

		const shapeScale = new Vec(scale.x, scale.y)

		// // make sure we are constraining aspect ratio, and using the smallest scale axis to avoid shapes getting bigger
		// // than the selection bounding box
		if (Math.abs(scale.x) > Math.abs(scale.y)) {
			shapeScale.x = Math.sign(scale.x) * Math.abs(scale.y)
		} else {
			shapeScale.y = Math.sign(scale.y) * Math.abs(scale.x)
		}

		// first we can scale the shape about its center point
		this.resizeShape(id, shapeScale, {
			initialShape: options.initialShape,
			initialBounds: options.initialBounds,
		})

		// then if the shape is flipped in one axis only, we need to apply an extra rotation
		// to make sure the shape is mirrored correctly
		if (Math.sign(scale.x) * Math.sign(scale.y) < 0) {
			let { rotation } = Mat.Decompose(options.initialPageTransform)
			rotation -= 2 * rotation
			this.updateShapes([{ id, type, rotation }])
		}

		// Next we need to translate the shape so that it's center point ends up in the right place.
		// To do that we first need to calculate the center point of the shape in the current page space before the scale was applied.
		const preScaleShapePageCenter = Mat.applyToPoint(
			options.initialPageTransform,
			options.initialBounds.center
		)

		// And now we scale the center point by the original scale factor
		const postScaleShapePageCenter = this._scalePagePoint(
			preScaleShapePageCenter,
			options.scaleOrigin,
			scale,
			options.scaleAxisRotation
		)

		// now calculate how far away the shape is from where it needs to be
		const pageBounds = this.getShapePageBounds(id)!
		const pageTransform = this.getShapePageTransform(id)!
		const currentPageCenter = pageBounds.center
		const shapePageTransformOrigin = pageTransform.point()
		if (!currentPageCenter || !shapePageTransformOrigin) return this
		const pageDelta = Vec.Sub(postScaleShapePageCenter, currentPageCenter)

		// and finally figure out what the shape's new position should be
		const postScaleShapePagePoint = Vec.Add(shapePageTransformOrigin, pageDelta)
		const { x, y } = this.getPointInParentSpace(id, postScaleShapePagePoint)

		this.updateShapes([{ id, type, x, y }])

		return this
	}

	/**
	 * Get the initial meta value for a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getInitialMetaForShape = (shape) => {
	 *   if (shape.type === 'note') {
	 *     return { createdBy: myCurrentUser.id }
	 *   }
	 * }
	 * ```
	 *
	 * @param shape - The shape to get the initial meta for.
	 *
	 * @public
	 */
	getInitialMetaForShape(_shape: TLShape): JsonObject {
		return {}
	}

	/**
	 * Create a single shape.
	 *
	 * @example
	 * ```ts
	 * editor.createShape(myShape)
	 * editor.createShape({ id: 'box1', type: 'text', props: { text: "ok" } })
	 * ```
	 *
	 * @param shape - The shape (or shape partial) to create.
	 *
	 * @public
	 */
	createShape<T extends TLUnknownShape>(shape: OptionalKeys<TLShapePartial<T>, 'id'>): this {
		this.createShapes([shape])
		return this
	}

	/**
	 * Create shapes.
	 *
	 * @example
	 * ```ts
	 * editor.createShapes([myShape])
	 * editor.createShapes([{ id: 'box1', type: 'text', props: { text: "ok" } }])
	 * ```
	 *
	 * @param shapes - The shapes (or shape partials) to create.
	 * @param select - Whether to select the created shapes. Defaults to false.
	 *
	 * @public
	 */
	createShapes<T extends TLUnknownShape>(
		shapes: OptionalKeys<TLShapePartial<T>, 'id'>[]
	): EditorResult<void> {
		if (!Array.isArray(shapes)) {
			return EditorResult.error('not-an-array-of-shapes')
		}
		if (this.getInstanceState().isReadonly) return EditorResult.error('readonly-room')
		if (shapes.length <= 0) return EditorResult.error('no-shapes-provied')

		const currentPageShapeIds = this.getCurrentPageShapeIds()

		const maxShapesReached = shapes.length + currentPageShapeIds.size > MAX_SHAPES_PER_PAGE

		if (maxShapesReached) {
			// can't create more shapes than fit on the page
			alertMaxShapes(this)
			return EditorResult.error('max-shapes-reached')
		}

		const focusedGroupId = this.getFocusedGroupId()

		this.batch(() => {
			// 1. Parents

			// Make sure that each partial will become the child of either the
			// page or another shape that exists (or that will exist) in this page.

			// find last parent id
			const currentPageShapesSorted = this.getCurrentPageShapesSorted()

			const partials = shapes.map((partial) => {
				if (!partial.id) {
					partial = { id: createShapeId(), ...partial }
				}

				// If the partial does not provide the parentId OR if the provided
				// parentId is NOT in the store AND NOT among the other shapes being
				// created, then we need to find a parent for the shape. This can be
				// another shape that exists under that point and which can receive
				// children of the creating shape's type, or else the page itself.
				if (
					!partial.parentId ||
					!(this.store.has(partial.parentId) || shapes.some((p) => p.id === partial.parentId))
				) {
					let parentId: TLParentId = this.getFocusedGroupId()

					for (let i = currentPageShapesSorted.length - 1; i >= 0; i--) {
						const parent = currentPageShapesSorted[i]
						if (
							// parent.type === 'frame'
							this.getShapeUtil(parent).canReceiveNewChildrenOfType(parent, partial.type) &&
							this.isPointInShape(
								parent,
								// If no parent is provided, then we can treat the
								// shape's provided x/y as being in the page's space.
								{ x: partial.x ?? 0, y: partial.y ?? 0 },
								{
									margin: 0,
									hitInside: true,
								}
							)
						) {
							parentId = parent.id
							break
						}
					}

					const prevParentId = partial.parentId

					// a shape cannot be it's own parent. This was a rare issue with frames/groups in the syncFuzz tests.
					if (parentId === partial.id) {
						parentId = focusedGroupId
					}

					// If the parentid has changed...
					if (parentId !== prevParentId) {
						partial = { ...partial }

						partial.parentId = parentId

						// If the parent is a shape (rather than a page) then insert the
						// shapes into the shape's children. Adjust the point and page rotation to be
						// preserved relative to the parent.
						if (isShapeId(parentId)) {
							const point = this.getPointInShapeSpace(this.getShape(parentId)!, {
								x: partial.x ?? 0,
								y: partial.y ?? 0,
							})
							partial.x = point.x
							partial.y = point.y
							partial.rotation =
								-this.getShapePageTransform(parentId)!.rotation() + (partial.rotation ?? 0)
						}
					}
				}

				return partial
			})

			// 2. Indices

			// Get the highest index among the parents of each of the
			// the shapes being created; we'll increment from there.

			const parentIndices = new Map<TLParentId, IndexKey>()

			const shapeRecordsToCreate: TLShape[] = []

			for (const partial of partials) {
				const util = this.getShapeUtil(partial as TLShapePartial)

				// If an index is not explicitly provided, then add the
				// shapes to the top of their parents' children; using the
				// value in parentsMappedToIndex, get the index above, use it,
				// and set it back to parentsMappedToIndex for next time.
				let index = partial.index

				if (!index) {
					// Hello bug-seeker: have you just created a frame and then a shape
					// and found that the shape is automatically the child of the frame?
					// this is the reason why! It would be harder to have each shape specify
					// the frame as the parent when creating a shape inside of a frame, so
					// we do it here.
					const parentId = partial.parentId ?? focusedGroupId

					if (!parentIndices.has(parentId)) {
						parentIndices.set(parentId, this.getHighestIndexForParent(parentId))
					}
					index = parentIndices.get(parentId)!
					parentIndices.set(parentId, getIndexAbove(index))
				}

				// The initial props starts as the shape utility's default props
				const initialProps = util.getDefaultProps()

				// We then look up each key in the tab state's styles; and if it's there,
				// we use the value from the tab state's styles instead of the default.
				for (const [style, propKey] of this.styleProps[partial.type]) {
					;(initialProps as any)[propKey] = this.getStyleForNextShape(style)
				}

				// When we create the shape, take in the partial (the props coming into the
				// function) and merge it with the default props.
				let shapeRecordToCreate = (
					this.store.schema.types.shape as RecordType<
						TLShape,
						'type' | 'props' | 'index' | 'parentId'
					>
				).create({
					...partial,
					index,
					opacity: partial.opacity ?? this.getInstanceState().opacityForNextShape,
					parentId: partial.parentId ?? focusedGroupId,
					props: 'props' in partial ? { ...initialProps, ...partial.props } : initialProps,
				})

				if (shapeRecordToCreate.index === undefined) {
					throw Error('no index!')
				}

				const next = this.getShapeUtil(shapeRecordToCreate).onBeforeCreate?.(shapeRecordToCreate)

				if (next) {
					shapeRecordToCreate = next
				}

				shapeRecordsToCreate.push(shapeRecordToCreate)
			}

			// Add meta properties, if any, to the shapes
			shapeRecordsToCreate.forEach((shape) => {
				shape.meta = {
					...this.getInitialMetaForShape(shape),
					...shape.meta,
				}
			})

			this.store.put(shapeRecordsToCreate)
		})
		return EditorResult.ok()
	}

	private animatingShapes = new Map<TLShapeId, string>()

	/**
	 * Animate a shape.
	 *
	 * @example
	 * ```ts
	 * editor.animateShape({ id: 'box1', type: 'box', x: 100, y: 100 })
	 * editor.animateShape({ id: 'box1', type: 'box', x: 100, y: 100 }, { duration: 100, ease: t => t*t })
	 * ```
	 *
	 * @param partial - The shape partial to update.
	 * @param options - The animation's options.
	 *
	 * @public
	 */
	animateShape(
		partial: TLShapePartial | null | undefined,
		animationOptions?: TLAnimationOptions
	): this {
		return this.animateShapes([partial], animationOptions)
	}

	/**
	 * Animate shapes.
	 *
	 * @example
	 * ```ts
	 * editor.animateShapes([{ id: 'box1', type: 'box', x: 100, y: 100 }])
	 * editor.animateShapes([{ id: 'box1', type: 'box', x: 100, y: 100 }], { duration: 100, ease: t => t*t })
	 * ```
	 *
	 * @param partials - The shape partials to update.
	 * @param options - The animation's options.
	 *
	 * @public
	 */
	animateShapes(
		partials: (TLShapePartial | null | undefined)[],
		animationOptions = {} as TLAnimationOptions
	): this {
		const { duration = 500, easing = EASINGS.linear } = animationOptions

		const animationId = uniqueId()

		let remaining = duration
		let t: number

		type ShapeAnimation = {
			partial: TLShapePartial
			values: { prop: string; from: number; to: number }[]
		}

		const animations: ShapeAnimation[] = []

		let partial: TLShapePartial | null | undefined, result: ShapeAnimation
		for (let i = 0, n = partials.length; i < n; i++) {
			partial = partials[i]
			if (!partial) continue

			result = {
				partial,
				values: [],
			}

			const shape = this.getShape(partial.id)!
			if (!shape) continue

			// We only support animations for certain props
			for (const key of ['x', 'y', 'rotation'] as const) {
				if (partial[key] !== undefined && shape[key] !== partial[key]) {
					result.values.push({ prop: key, from: shape[key], to: partial[key] as number })
				}
			}

			animations.push(result)
			this.animatingShapes.set(shape.id, animationId)
		}

		let value: ShapeAnimation

		const handleTick = (elapsed: number) => {
			remaining -= elapsed

			if (remaining < 0) {
				const { animatingShapes } = this
				const partialsToUpdate = partials.filter(
					(p) => p && animatingShapes.get(p.id) === animationId
				)
				if (partialsToUpdate.length) {
					this.updateShapes(partialsToUpdate)
					// update shapes also removes the shape from animating shapes
				}

				this.removeListener('tick', handleTick)
				return
			}

			t = easing(1 - remaining / duration)

			const { animatingShapes } = this

			const updates: TLShapePartial[] = []

			let animationIdForShape: string | undefined
			for (let i = 0, n = animations.length; i < n; i++) {
				value = animations[i]
				// Is the animation for this shape still active?
				animationIdForShape = animatingShapes.get(value.partial.id)
				if (animationIdForShape !== animationId) continue

				// Create the update
				updates.push({
					id: value.partial.id,
					type: value.partial.type,
					...value.values.reduce((acc, { prop, from, to }) => {
						acc[prop] = from + (to - from) * t
						return acc
					}, {} as any),
				})
			}

			this._updateShapes(updates)
		}

		this.addListener('tick', handleTick)

		return this
	}

	/**
	 * Create a group containing the provided shapes.
	 *
	 * @param shapes - The shapes (or shape ids) to group. Defaults to the selected shapes.
	 * @param groupId - The id of the group to create.
	 *
	 * @public
	 */
	groupShapes(shapes: TLShapeId[] | TLShape[], groupId = createShapeId()): this {
		if (!Array.isArray(shapes)) {
			throw Error('Editor.groupShapes: must provide an array of shapes or shape ids')
		}
		if (this.getInstanceState().isReadonly) return this

		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes.map((s) => (s as TLShape).id) as TLShapeId[])

		if (ids.length <= 1) return this

		const shapesToGroup = compact(this._getUnlockedShapeIds(ids).map((id) => this.getShape(id)))
		const sortedShapeIds = shapesToGroup.sort(sortByIndex).map((s) => s.id)
		const pageBounds = Box.Common(compact(shapesToGroup.map((id) => this.getShapePageBounds(id))))

		const { x, y } = pageBounds.point

		const parentId = this.findCommonAncestor(shapesToGroup) ?? this.getCurrentPageId()

		// Only group when the select tool is active
		if (this.getCurrentToolId() !== 'select') return this

		// If not already in idle, cancel the current interaction (get back to idle)
		if (!this.isIn('select.idle')) {
			this.cancel()
		}

		// Find all the shapes that have the same parentId, and use the highest index.
		const shapesWithRootParent = shapesToGroup
			.filter((shape) => shape.parentId === parentId)
			.sort(sortByIndex)

		const highestIndex = shapesWithRootParent[shapesWithRootParent.length - 1]?.index

		this.batch(() => {
			this.createShapes<TLGroupShape>([
				{
					id: groupId,
					type: 'group',
					parentId,
					index: highestIndex,
					x,
					y,
					opacity: 1,
					props: {},
				},
			])
			this.reparentShapes(sortedShapeIds, groupId)
			this.select(groupId)
		})

		return this
	}

	/**
	 * Ungroup some shapes.
	 *
	 * @param ids - Ids of the shapes to ungroup. Defaults to the selected shapes.
	 *
	 * @public
	 */
	ungroupShapes(ids: TLShapeId[]): this
	ungroupShapes(ids: TLShape[]): this
	ungroupShapes(_ids: TLShapeId[] | TLShape[]) {
		const ids =
			typeof _ids[0] === 'string' ? (_ids as TLShapeId[]) : (_ids as TLShape[]).map((s) => s.id)
		if (this.getInstanceState().isReadonly) return this
		if (ids.length === 0) return this

		// Only ungroup when the select tool is active
		if (this.getCurrentToolId() !== 'select') return this

		// If not already in idle, cancel the current interaction (get back to idle)
		if (!this.isIn('select.idle')) {
			this.cancel()
		}

		// The ids of the selected shapes after ungrouping;
		// these include all of the grouped shapes children,
		// plus any shapes that were selected apart from the groups.
		const idsToSelect = new Set<TLShapeId>()

		// Get all groups in the selection
		const shapes = compact(ids.map((id) => this.getShape(id)))

		const groups: TLGroupShape[] = []

		shapes.forEach((shape) => {
			if (this.isShapeOfType<TLGroupShape>(shape, 'group')) {
				groups.push(shape)
			} else {
				idsToSelect.add(shape.id)
			}
		})

		if (groups.length === 0) return this

		this.batch(() => {
			let group: TLGroupShape

			for (let i = 0, n = groups.length; i < n; i++) {
				group = groups[i]
				const childIds = this.getSortedChildIdsForParent(group.id)

				for (let j = 0, n = childIds.length; j < n; j++) {
					idsToSelect.add(childIds[j])
				}

				this.reparentShapes(childIds, group.parentId, group.index)
			}

			this.deleteShapes(groups.map((group) => group.id))
			this.select(...idsToSelect)
		})

		return this
	}

	/**
	 * Update a shape using a partial of the shape.
	 *
	 * @example
	 * ```ts
	 * editor.updateShape({ id: 'box1', type: 'geo', props: { w: 100, h: 100 } })
	 * ```
	 *
	 * @param partial - The shape partial to update.
	 *
	 * @public
	 */
	updateShape<T extends TLUnknownShape>(partial: TLShapePartial<T> | null | undefined) {
		this.updateShapes([partial])
		return this
	}

	/**
	 * Update shapes using partials of each shape.
	 *
	 * @example
	 * ```ts
	 * editor.updateShapes([{ id: 'box1', type: 'geo', props: { w: 100, h: 100 } }])
	 * ```
	 *
	 * @param partials - The shape partials to update.
	 *
	 * @public
	 */
	updateShapes<T extends TLUnknownShape>(partials: (TLShapePartial<T> | null | undefined)[]) {
		const compactedPartials: TLShapePartial<T>[] = Array(partials.length)

		for (let i = 0, n = partials.length; i < n; i++) {
			const partial = partials[i]
			if (!partial) continue
			// Get the current shape referenced by the partial
			const shape = this.getShape(partial.id)
			if (!shape) continue

			// If the shape is locked and we're not setting isLocked to true, continue
			if (this.isShapeOrAncestorLocked(shape) && !Object.hasOwn(partial, 'isLocked')) continue

			// Remove any animating shapes from the list of partials
			this.animatingShapes.delete(partial.id)

			compactedPartials.push(partial)
		}

		this._updateShapes(compactedPartials)
		return this
	}

	/** @internal */
	private _updateShapes = (_partials: (TLShapePartial | null | undefined)[]) => {
		if (this.getInstanceState().isReadonly) return

		this.batch(() => {
			const updates = []

			let shape: TLShape | undefined
			let updated: TLShape

			for (let i = 0, n = _partials.length; i < n; i++) {
				const partial = _partials[i]
				// Skip nullish partials (sometimes created by map fns returning undefined)
				if (!partial) continue

				// Get the current shape referenced by the partial
				// If there is no current shape, we'll skip this update
				shape = this.getShape(partial.id)
				if (!shape) continue

				// Get the updated version of the shape
				// If the update had no effect, we'll skip this update
				updated = applyPartialToShape(shape, partial)
				if (updated === shape) continue

				//if any shape has an onBeforeUpdate handler, call it and, if the handler returns a
				// new shape, replace the old shape with the new one. This is used for example when
				// repositioning a text shape based on its new text content.
				updated = this.getShapeUtil(shape).onBeforeUpdate?.(shape, updated) ?? updated

				updates.push(updated)
			}

			this.store.put(updates)
		})
	}

	/** @internal */
	private _getUnlockedShapeIds(ids: TLShapeId[]): TLShapeId[] {
		return ids.filter((id) => !this.getShape(id)?.isLocked)
	}

	/**
	 * Delete shapes.
	 *
	 * @example
	 * ```ts
	 * editor.deleteShapes(['box1', 'box2'])
	 * ```
	 *
	 * @param ids - The ids of the shapes to delete.
	 *
	 * @public
	 */
	deleteShapes(ids: TLShapeId[]): this
	deleteShapes(shapes: TLShape[]): this
	deleteShapes(_ids: TLShapeId[] | TLShape[]): this {
		if (!Array.isArray(_ids)) {
			throw Error('Editor.deleteShapes: must provide an array of shapes or shapeIds')
		}

		const ids = this._getUnlockedShapeIds(
			typeof _ids[0] === 'string' ? (_ids as TLShapeId[]) : (_ids as TLShape[]).map((s) => s.id)
		)

		if (this.getInstanceState().isReadonly) return this
		if (ids.length === 0) return this

		const allIds = new Set(ids)

		for (const id of ids) {
			this.visitDescendants(id, (childId) => {
				allIds.add(childId)
			})
		}

		const deletedIds = [...allIds]
		return this.batch(() => this.store.remove(deletedIds))
	}

	/**
	 * Delete a shape.
	 *
	 * @example
	 * ```ts
	 * editor.deleteShape(shape.id)
	 * ```
	 *
	 * @param id - The id of the shape to delete.
	 *
	 * @public
	 */
	deleteShape(id: TLShapeId): this
	deleteShape(shape: TLShape): this
	deleteShape(_id: TLShapeId | TLShape) {
		this.deleteShapes([typeof _id === 'string' ? _id : _id.id])
		return this
	}

	/* --------------------- Styles --------------------- */

	/**
	 * Get all the current styles among the users selected shapes
	 *
	 * @internal
	 */
	private _extractSharedStyles(shape: TLShape, sharedStyleMap: SharedStyleMap) {
		if (this.isShapeOfType<TLGroupShape>(shape, 'group')) {
			// For groups, ignore the styles of the group shape and instead include the styles of the
			// group's children. These are the shapes that would have their styles changed if the
			// user called `setStyle` on the current selection.
			const childIds = this._parentIdsToChildIds.get()[shape.id]
			if (!childIds) return

			for (let i = 0, n = childIds.length; i < n; i++) {
				this._extractSharedStyles(this.getShape(childIds[i])!, sharedStyleMap)
			}
		} else {
			for (const [style, propKey] of this.styleProps[shape.type]) {
				sharedStyleMap.applyValue(style, getOwnProperty(shape.props, propKey))
			}
		}
	}

	/**
	 * A derived map containing all current styles among the user's selected shapes.
	 *
	 * @internal
	 */
	@computed
	private _getSelectionSharedStyles(): ReadonlySharedStyleMap {
		const selectedShapes = this.getSelectedShapes()

		const sharedStyles = new SharedStyleMap()
		for (const selectedShape of selectedShapes) {
			this._extractSharedStyles(selectedShape, sharedStyles)
		}

		return sharedStyles
	}

	/**
	 * Get the style for the next shape.
	 *
	 * @example
	 * ```ts
	 * const color = editor.getStyleForNextShape(DefaultColorStyle)
	 * ```
	 *
	 * @param style - The style to get.
	 *
	 * @public */
	getStyleForNextShape<T>(style: StyleProp<T>): T {
		const value = this.getInstanceState().stylesForNextShape[style.id]
		return value === undefined ? style.defaultValue : (value as T)
	}

	getShapeStyleIfExists<T>(shape: TLShape, style: StyleProp<T>): T | undefined {
		const styleKey = this.styleProps[shape.type].get(style)
		if (styleKey === undefined) return undefined
		return getOwnProperty(shape.props, styleKey) as T | undefined
	}

	/**
	 * A map of all the current styles either in the current selection, or that are relevant to the
	 * current tool.
	 *
	 * @example
	 * ```ts
	 * const color = editor.getSharedStyles().get(DefaultColorStyle)
	 * if (color && color.type === 'shared') {
	 *   print('All selected shapes have the same color:', color.value)
	 * }
	 * ```
	 *
	 * @public
	 */
	@computed<ReadonlySharedStyleMap>({ isEqual: (a, b) => a.equals(b) })
	getSharedStyles(): ReadonlySharedStyleMap {
		// If we're in selecting and if we have a selection, return the shared styles from the
		// current selection
		if (this.isIn('select') && this.getSelectedShapeIds().length > 0) {
			return this._getSelectionSharedStyles()
		}

		// If the current tool is associated with a shape, return the styles for that shape.
		// Otherwise, just return an empty map.
		const currentTool = this.root.getCurrent()!
		const styles = new SharedStyleMap()

		if (!currentTool) return styles

		if (currentTool.shapeType) {
			for (const style of this.styleProps[currentTool.shapeType].keys()) {
				styles.applyValue(style, this.getStyleForNextShape(style))
			}
		}

		return styles
	}

	/**
	 * Get the currently selected shared opacity.
	 * If any shapes are selected, this returns the shared opacity of the selected shapes.
	 * Otherwise, this returns the chosen opacity for the next shape.
	 *
	 * @public
	 */
	@computed getSharedOpacity(): SharedStyle<number> {
		if (this.isIn('select') && this.getSelectedShapeIds().length > 0) {
			const shapesToCheck: TLShape[] = []
			const addShape = (shapeId: TLShapeId) => {
				const shape = this.getShape(shapeId)
				if (!shape) return
				// For groups, ignore the opacity of the group shape and instead include
				// the opacity of the group's children. These are the shapes that would have
				// their opacity changed if the user called `setOpacity` on the current selection.
				if (this.isShapeOfType<TLGroupShape>(shape, 'group')) {
					for (const childId of this.getSortedChildIdsForParent(shape.id)) {
						addShape(childId)
					}
				} else {
					shapesToCheck.push(shape)
				}
			}
			for (const shapeId of this.getSelectedShapeIds()) {
				addShape(shapeId)
			}

			let opacity: number | null = null
			for (const shape of shapesToCheck) {
				if (opacity === null) {
					opacity = shape.opacity
				} else if (opacity !== shape.opacity) {
					return { type: 'mixed' }
				}
			}

			if (opacity !== null) return { type: 'shared', value: opacity }
		}
		return { type: 'shared', value: this.getInstanceState().opacityForNextShape }
	}

	/**
	 * Set the opacity for the next shapes. This will effect subsequently created shapes.
	 *
	 * @example
	 * ```ts
	 * editor.setOpacityForNextShapes(0.5)
	 * ```
	 *
	 * @param opacity - The opacity to set. Must be a number between 0 and 1 inclusive.
	 * @param historyOptions - The history options for the change.
	 */
	setOpacityForNextShapes(opacity: number, historyOptions?: TLHistoryBatchOptions): this {
		this.updateInstanceState({ opacityForNextShape: opacity }, historyOptions)
		return this
	}

	/**
	 * Set the current opacity. This will effect any selected shapes.
	 *
	 * @example
	 * ```ts
	 * editor.setOpacityForSelectedShapes(0.5)
	 * ```
	 *
	 * @param opacity - The opacity to set. Must be a number between 0 and 1 inclusive.
	 */
	setOpacityForSelectedShapes(opacity: number): this {
		const selectedShapes = this.getSelectedShapes()

		if (selectedShapes.length > 0) {
			const shapesToUpdate: TLShape[] = []

			// We can have many deep levels of grouped shape
			// Making a recursive function to look through all the levels
			const addShapeById = (shape: TLShape) => {
				if (this.isShapeOfType<TLGroupShape>(shape, 'group')) {
					const childIds = this.getSortedChildIdsForParent(shape)
					for (const childId of childIds) {
						addShapeById(this.getShape(childId)!)
					}
				} else {
					shapesToUpdate.push(shape)
				}
			}

			for (const id of selectedShapes) {
				addShapeById(id)
			}

			this.updateShapes(
				shapesToUpdate.map((shape) => {
					return {
						id: shape.id,
						type: shape.type,
						opacity,
					}
				})
			)
		}

		return this
	}

	/**
	 * Set the value of a {@link @tldraw/tlschema#StyleProp} for the next shapes. This change will be applied to subsequently created shapes.
	 *
	 * @example
	 * ```ts
	 * editor.setStyleForNextShapes(DefaultColorStyle, 'red')
	 * editor.setStyleForNextShapes(DefaultColorStyle, 'red', { ephemeral: true })
	 * ```
	 *
	 * @param style - The style to set.
	 * @param value - The value to set.
	 * @param historyOptions - The history options for the change.
	 *
	 * @public
	 */
	setStyleForNextShapes<T>(
		style: StyleProp<T>,
		value: T,
		historyOptions?: TLHistoryBatchOptions
	): this {
		const stylesForNextShape = this.getInstanceState().stylesForNextShape

		this.updateInstanceState(
			{ stylesForNextShape: { ...stylesForNextShape, [style.id]: value } },
			historyOptions
		)

		return this
	}

	/**
	 * Set the value of a {@link @tldraw/tlschema#StyleProp}. This change will be applied to the currently selected shapes.
	 *
	 * @example
	 * ```ts
	 * editor.setStyleForSelectedShapes(DefaultColorStyle, 'red')
	 * ```
	 *
	 * @param style - The style to set.
	 * @param value - The value to set.
	 * @param historyOptions - The history options for the change.
	 *
	 * @public
	 */
	setStyleForSelectedShapes<S extends StyleProp<any>>(style: S, value: StylePropValue<S>): this {
		const selectedShapes = this.getSelectedShapes()

		if (selectedShapes.length > 0) {
			const updates: {
				util: ShapeUtil
				originalShape: TLShape
				updatePartial: TLShapePartial
			}[] = []

			// We can have many deep levels of grouped shape
			// Making a recursive function to look through all the levels
			const addShapeById = (shape: TLShape) => {
				if (this.isShapeOfType<TLGroupShape>(shape, 'group')) {
					const childIds = this.getSortedChildIdsForParent(shape.id)
					for (const childId of childIds) {
						addShapeById(this.getShape(childId)!)
					}
				} else {
					const util = this.getShapeUtil(shape)
					const stylePropKey = this.styleProps[shape.type].get(style)
					if (stylePropKey) {
						const shapePartial: TLShapePartial = {
							id: shape.id,
							type: shape.type,
							props: { [stylePropKey]: value },
						}
						updates.push({
							util,
							originalShape: shape,
							updatePartial: shapePartial,
						})
					}
				}
			}

			for (const shape of selectedShapes) {
				addShapeById(shape)
			}

			this.updateShapes(updates.map(({ updatePartial }) => updatePartial))
		}

		return this
	}

	/* --------------------- Content -------------------- */

	/** @internal */
	externalAssetContentHandlers: {
		[K in TLExternalAssetContent['type']]: {
			[Key in K]:
				| null
				| ((info: TLExternalAssetContent & { type: Key }) => Promise<TLAsset | undefined>)
		}[K]
	} = {
		file: null,
		url: null,
	}

	/**
	 * Register an external content handler. This handler will be called when the editor receives
	 * external content of the provided type. For example, the 'image' type handler will be called
	 * when a user drops an image onto the canvas.
	 *
	 * @example
	 * ```ts
	 * editor.registerExternalAssetHandler('text', myHandler)
	 * ```
	 *
	 * @param type - The type of external content.
	 * @param handler - The handler to use for this content type.
	 *
	 * @public
	 */
	registerExternalAssetHandler<T extends TLExternalAssetContent['type']>(
		type: T,
		handler: null | ((info: TLExternalAssetContent & { type: T }) => Promise<TLAsset>)
	): this {
		this.externalAssetContentHandlers[type] = handler as any
		return this
	}

	/**
	 * Get an asset for an external asset content type.
	 *
	 * @example
	 * ```ts
	 * const asset = await editor.getAssetForExternalContent({ type: 'file', file: myFile })
	 * const asset = await editor.getAssetForExternalContent({ type: 'url', url: myUrl })
	 * ```
	 *
	 * @param info - Info about the external content.
	 * @returns The asset.
	 */
	async getAssetForExternalContent(info: TLExternalAssetContent): Promise<TLAsset | undefined> {
		return await this.externalAssetContentHandlers[info.type]?.(info as any)
	}

	/** @internal */
	externalContentHandlers: {
		[K in TLExternalContent['type']]: {
			[Key in K]: null | ((info: TLExternalContent & { type: Key }) => void)
		}[K]
	} = {
		text: null,
		files: null,
		embed: null,
		'svg-text': null,
		url: null,
	}

	/**
	 * Register an external content handler. This handler will be called when the editor receives
	 * external content of the provided type. For example, the 'image' type handler will be called
	 * when a user drops an image onto the canvas.
	 *
	 * @example
	 * ```ts
	 * editor.registerExternalContentHandler('text', myHandler)
	 * ```
	 *
	 * @param type - The type of external content.
	 * @param handler - The handler to use for this content type.
	 *
	 * @public
	 */
	registerExternalContentHandler<T extends TLExternalContent['type']>(
		type: T,
		handler:
			| null
			| ((
					info: T extends TLExternalContent['type']
						? TLExternalContent & { type: T }
						: TLExternalContent
			  ) => void)
	): this {
		this.externalContentHandlers[type] = handler as any
		return this
	}

	/**
	 * Handle external content, such as files, urls, embeds, or plain text which has been put into the app, for example by pasting external text or dropping external images onto canvas.
	 *
	 * @param info - Info about the external content.
	 */
	async putExternalContent(info: TLExternalContent): Promise<void> {
		return this.externalContentHandlers[info.type]?.(info as any)
	}

	/**
	 * Get content that can be exported for the given shape ids.
	 *
	 * @param shapes - The shapes (or shape ids) to get content for.
	 *
	 * @returns The exported content.
	 *
	 * @public
	 */
	getContentFromCurrentPage(shapes: TLShapeId[] | TLShape[]): TLContent | undefined {
		// todo: make this work with any page, not just the current page
		const ids =
			typeof shapes[0] === 'string'
				? (shapes as TLShapeId[])
				: (shapes as TLShape[]).map((s) => s.id)

		if (!ids) return
		if (ids.length === 0) return

		const pageTransforms: Record<string, MatModel> = {}

		let shapesForContent = dedupe(
			ids
				.map((id) => this.getShape(id)!)
				.sort(sortByIndex)
				.flatMap((shape) => {
					const allShapes = [shape]
					this.visitDescendants(shape.id, (descendant) => {
						allShapes.push(this.getShape(descendant)!)
					})
					return allShapes
				})
		)

		shapesForContent = shapesForContent.map((shape) => {
			pageTransforms[shape.id] = this.getShapePageTransform(shape.id)!

			shape = structuredClone(shape) as typeof shape

			if (this.isShapeOfType<TLArrowShape>(shape, 'arrow')) {
				const startBindingId =
					shape.props.start.type === 'binding' ? shape.props.start.boundShapeId : undefined

				const endBindingId =
					shape.props.end.type === 'binding' ? shape.props.end.boundShapeId : undefined

				const info = this.getArrowInfo(shape)

				if (shape.props.start.type === 'binding') {
					if (!shapesForContent.some((s) => s.id === startBindingId)) {
						// Uh oh, the arrow's bound-to shape isn't among the shapes
						// that we're getting the content for. We should try to adjust
						// the arrow so that it appears in the place it would be
						if (info?.isValid) {
							const { x, y } = info.start.point
							shape.props.start = {
								type: 'point',
								x,
								y,
							}
						} else {
							const { start } = getArrowTerminalsInArrowSpace(this, shape)
							shape.props.start = {
								type: 'point',
								x: start.x,
								y: start.y,
							}
						}
					}
				}

				if (shape.props.end.type === 'binding') {
					if (!shapesForContent.some((s) => s.id === endBindingId)) {
						if (info?.isValid) {
							const { x, y } = info.end.point
							shape.props.end = {
								type: 'point',
								x,
								y,
							}
						} else {
							const { end } = getArrowTerminalsInArrowSpace(this, shape)
							shape.props.end = {
								type: 'point',
								x: end.x,
								y: end.y,
							}
						}
					}
				}

				const infoAfter = getIsArrowStraight(shape)
					? getStraightArrowInfo(this, shape)
					: getCurvedArrowInfo(this, shape)

				if (info?.isValid && infoAfter?.isValid && !getIsArrowStraight(shape)) {
					const mpA = Vec.Med(info.start.handle, info.end.handle)
					const distA = Vec.Dist(info.middle, mpA)
					const distB = Vec.Dist(infoAfter.middle, mpA)
					if (shape.props.bend < 0) {
						shape.props.bend += distB - distA
					} else {
						shape.props.bend -= distB - distA
					}
				}

				return shape
			}

			return shape
		})

		const rootShapeIds: TLShapeId[] = []

		shapesForContent.forEach((shape) => {
			if (shapesForContent.find((s) => s.id === shape.parentId) === undefined) {
				// Need to get page point and rotation of the shape because shapes in
				// groups use local position/rotation

				const pageTransform = this.getShapePageTransform(shape.id)!
				const pagePoint = pageTransform.point()
				const pageRotation = pageTransform.rotation()
				shape.x = pagePoint.x
				shape.y = pagePoint.y
				shape.rotation = pageRotation
				shape.parentId = this.getCurrentPageId()

				rootShapeIds.push(shape.id)
			}
		})

		const assetsSet = new Set<TLAssetId>()

		shapesForContent.forEach((shape) => {
			if ('assetId' in shape.props) {
				if (shape.props.assetId !== null) {
					assetsSet.add(shape.props.assetId)
				}
			}
		})

		return {
			shapes: shapesForContent,
			rootShapeIds,
			schema: this.store.schema.serialize(),
			assets: compact(Array.from(assetsSet).map((id) => this.getAsset(id))),
		}
	}

	/**
	 * Place content into the editor.
	 *
	 * @param content - The content.
	 * @param options - Options for placing the content.
	 *
	 * @public
	 */
	putContentOntoCurrentPage(
		content: TLContent,
		options: {
			point?: VecLike
			select?: boolean
			preservePosition?: boolean
			preserveIds?: boolean
		} = {}
	): this {
		if (this.getInstanceState().isReadonly) return this

		// todo: make this able to support putting content onto any page, not just the current page

		if (!content.schema) {
			throw Error('Could not put content:\ncontent is missing a schema.')
		}

		const { select = false, preserveIds = false, preservePosition = false } = options
		let { point = undefined } = options

		// decide on a parent for the put shapes; if the parent is among the put shapes(?) then use its parent

		const currentPageId = this.getCurrentPageId()
		const { rootShapeIds } = content

		// We need to collect the migrated shapes and assets
		const assets: TLAsset[] = []
		const shapes: TLShape[] = []

		// Let's treat the content as a store, and then migrate that store.
		const store: StoreSnapshot<TLRecord> = {
			store: {
				...Object.fromEntries(content.assets.map((asset) => [asset.id, asset] as const)),
				...Object.fromEntries(content.shapes.map((asset) => [asset.id, asset] as const)),
			},
			schema: content.schema,
		}
		const result = this.store.schema.migrateStoreSnapshot(store)
		if (result.type === 'error') {
			throw Error('Could not put content: could not migrate content')
		}
		for (const record of Object.values(result.value)) {
			switch (record.typeName) {
				case 'asset': {
					assets.push(record)
					break
				}
				case 'shape': {
					shapes.push(record)
					break
				}
			}
		}

		// Ok, we've got our migrated shapes and assets, now we can continue!
		const idMap = new Map<any, TLShapeId>(shapes.map((shape) => [shape.id, createShapeId()]))

		// By default, the paste parent will be the current page.
		let pasteParentId = this.getCurrentPageId() as TLPageId | TLShapeId
		let lowestDepth = Infinity
		let lowestAncestors: TLShape[] = []

		// Among the selected shapes, find the shape with the fewest ancestors and use its first ancestor.
		for (const shape of this.getSelectedShapes()) {
			if (lowestDepth === 0) break

			const isFrame = this.isShapeOfType<TLFrameShape>(shape, 'frame')
			const ancestors = this.getShapeAncestors(shape)
			if (isFrame) ancestors.push(shape)

			const depth = isFrame ? ancestors.length + 1 : ancestors.length

			if (depth < lowestDepth) {
				lowestDepth = depth
				lowestAncestors = ancestors
				pasteParentId = isFrame ? shape.id : shape.parentId
			} else if (depth === lowestDepth) {
				if (lowestAncestors.length !== ancestors.length) {
					throw Error(`Ancestors: ${lowestAncestors.length} !== ${ancestors.length}`)
				}

				if (lowestAncestors.length === 0) {
					pasteParentId = currentPageId
					break
				} else {
					pasteParentId = currentPageId
					for (let i = 0; i < lowestAncestors.length; i++) {
						if (ancestors[i] !== lowestAncestors[i]) break
						pasteParentId = ancestors[i].id
					}
				}
			}
		}

		let isDuplicating = false

		if (!isPageId(pasteParentId)) {
			const parent = this.getShape(pasteParentId)
			if (parent) {
				if (!this.getViewportPageBounds().includes(this.getShapePageBounds(parent)!)) {
					pasteParentId = currentPageId
				} else {
					if (rootShapeIds.length === 1) {
						const rootShape = shapes.find((s) => s.id === rootShapeIds[0])!
						if (
							this.isShapeOfType<TLFrameShape>(parent, 'frame') &&
							this.isShapeOfType<TLFrameShape>(rootShape, 'frame') &&
							rootShape.props.w === parent?.props.w &&
							rootShape.props.h === parent?.props.h
						) {
							isDuplicating = true
						}
					}
				}
			} else {
				pasteParentId = currentPageId
			}
		}

		if (!isDuplicating) {
			isDuplicating = idMap.has(pasteParentId)
		}

		if (isDuplicating) {
			pasteParentId = this.getShape(pasteParentId)!.parentId
		}

		let index = this.getHighestIndexForParent(pasteParentId) // todo: requires that the putting page is the current page

		const rootShapes: TLShape[] = []

		const newShapes: TLShape[] = shapes.map((shape): TLShape => {
			let newShape: TLShape

			if (preserveIds) {
				newShape = structuredClone(shape)
				idMap.set(shape.id, shape.id)
			} else {
				const id = idMap.get(shape.id)!

				// Create the new shape (new except for the id)
				newShape = structuredClone({ ...shape, id })
			}

			if (rootShapeIds.includes(shape.id)) {
				newShape.parentId = currentPageId
				rootShapes.push(newShape)
			}

			// Assign the child to its new parent.

			// If the child's parent is among the putting shapes, then assign
			// it to the new parent's id.
			if (idMap.has(newShape.parentId)) {
				newShape.parentId = idMap.get(shape.parentId)!
			} else {
				rootShapeIds.push(newShape.id)
				// newShape.parentId = pasteParentId
				newShape.index = index
				index = getIndexAbove(index)
			}

			if (this.isShapeOfType<TLArrowShape>(newShape, 'arrow')) {
				if (newShape.props.start.type === 'binding') {
					const mappedId = idMap.get(newShape.props.start.boundShapeId)
					newShape.props.start = mappedId
						? { ...newShape.props.start, boundShapeId: mappedId }
						: // this shouldn't happen, if you copy an arrow but not it's bound shape it should
							// convert the binding to a point at the time of copying
							{ type: 'point', x: 0, y: 0 }
				}
				if (newShape.props.end.type === 'binding') {
					const mappedId = idMap.get(newShape.props.end.boundShapeId)
					newShape.props.end = mappedId
						? { ...newShape.props.end, boundShapeId: mappedId }
						: // this shouldn't happen, if you copy an arrow but not it's bound shape it should
							// convert the binding to a point at the time of copying
							{ type: 'point', x: 0, y: 0 }
				}
			}

			return newShape
		})

		if (newShapes.length + this.getCurrentPageShapeIds().size > MAX_SHAPES_PER_PAGE) {
			// There's some complexity here involving children
			// that might be created without their parents, so
			// if we're going over the limit then just don't paste.
			alertMaxShapes(this)
			return this
		}

		// These are all the assets we need to create
		const assetsToCreate: TLAsset[] = []

		// These assets have base64 data that may need to be hosted
		const assetsToUpdate: (TLImageAsset | TLVideoAsset)[] = []

		for (const asset of assets) {
			if (this.store.has(asset.id)) {
				// We already have this asset
				continue
			}

			if (
				(asset.type === 'image' || asset.type === 'video') &&
				asset.props.src?.startsWith('data:image')
			) {
				// it's src is a base64 image or video; we need to create a new asset without the src,
				// then create a new asset from the original src. So we save a copy of the original asset,
				// then delete the src from the original asset.
				assetsToUpdate.push(structuredClone(asset as TLImageAsset | TLVideoAsset))
				asset.props.src = null
			}

			// Add the asset to the list of assets to create
			assetsToCreate.push(asset)
		}

		// Start loading the new assets, order does not matter
		Promise.allSettled(
			(assetsToUpdate as (TLImageAsset | TLVideoAsset)[]).map(async (asset) => {
				// Turn the data url into a file
				const file = await dataUrlToFile(
					asset.props.src!,
					asset.props.name,
					asset.props.mimeType ?? 'image/png'
				)

				// Get a new asset for the file
				const newAsset = await this.getAssetForExternalContent({ type: 'file', file })

				if (!newAsset) {
					// If we don't have a new asset, delete the old asset.
					// The shapes that reference this asset should break.
					this.deleteAssets([asset.id])
					return
				}

				// Save the new asset under the old asset's id
				this.updateAssets([{ ...newAsset, id: asset.id }])
			})
		)

		this.batch(() => {
			// Create any assets that need to be created
			if (assetsToCreate.length > 0) {
				this.createAssets(assetsToCreate)
			}

			// Create the shapes with root shapes as children of the page
			this.createShapes(newShapes)

			if (select) {
				this.select(...rootShapes.map((s) => s.id))
			}

			// And then, if needed, reparent the root shapes to the paste parent
			if (pasteParentId !== currentPageId) {
				this.reparentShapes(
					rootShapes.map((s) => s.id),
					pasteParentId
				)
			}

			const newCreatedShapes = newShapes.map((s) => this.getShape(s.id)!)
			const bounds = Box.Common(newCreatedShapes.map((s) => this.getShapePageBounds(s)!))

			if (point === undefined) {
				if (!isPageId(pasteParentId)) {
					// Put the shapes in the middle of the (on screen) parent
					const shape = this.getShape(pasteParentId)!
					point = Mat.applyToPoint(
						this.getShapePageTransform(shape),
						this.getShapeGeometry(shape).bounds.center
					)
				} else {
					const viewportPageBounds = this.getViewportPageBounds()
					if (preservePosition || viewportPageBounds.includes(Box.From(bounds))) {
						// Otherwise, put shapes where they used to be
						point = bounds.center
					} else {
						// If the old bounds are outside of the viewport...
						// put the shapes in the middle of the viewport
						point = viewportPageBounds.center
					}
				}
			}

			if (rootShapes.length === 1) {
				const onlyRoot = rootShapes[0] as TLFrameShape
				// If the old bounds are in the viewport...
				if (this.isShapeOfType<TLFrameShape>(onlyRoot, 'frame')) {
					while (
						this.getShapesAtPoint(point).some(
							(shape) =>
								this.isShapeOfType<TLFrameShape>(shape, 'frame') &&
								shape.props.w === onlyRoot.props.w &&
								shape.props.h === onlyRoot.props.h
						)
					) {
						point.x += bounds.w + 16
					}
				}
			}

			const pageCenter = Box.Common(
				compact(rootShapes.map(({ id }) => this.getShapePageBounds(id)))
			).center

			const offset = Vec.Sub(point, pageCenter)

			this.updateShapes(
				rootShapes.map(({ id }) => {
					const s = this.getShape(id)!
					const localRotation = this.getShapeParentTransform(id).decompose().rotation
					const localDelta = Vec.Rot(offset, -localRotation)

					return { id: s.id, type: s.type, x: s.x + localDelta.x, y: s.y + localDelta.y }
				})
			)
		})

		return this
	}

	/**
	 * Get an exported SVG element of the given shapes.
	 *
	 * @param ids - The shapes (or shape ids) to export.
	 * @param opts - Options for the export.
	 *
	 * @returns The SVG element.
	 *
	 * @public
	 */
	async getSvgElement(shapes: TLShapeId[] | TLShape[], opts = {} as Partial<TLSvgOptions>) {
		const result = await getSvgJsx(this, shapes, opts)
		if (!result) return undefined

		const fragment = document.createDocumentFragment()
		const root = createRoot(fragment)
		flushSync(() => {
			root.render(result.jsx)
		})

		const svg = fragment.firstElementChild
		assert(svg instanceof SVGSVGElement, 'Expected an SVG element')

		root.unmount()
		return { svg, width: result.width, height: result.height }
	}

	/**
	 * Get an exported SVG string of the given shapes.
	 *
	 * @param ids - The shapes (or shape ids) to export.
	 * @param opts - Options for the export.
	 *
	 * @returns The SVG element.
	 *
	 * @public
	 */
	async getSvgString(shapes: TLShapeId[] | TLShape[], opts = {} as Partial<TLSvgOptions>) {
		const result = await this.getSvgElement(shapes, opts)
		if (!result) return undefined

		const serializer = new XMLSerializer()
		return {
			svg: serializer.serializeToString(result.svg),
			width: result.width,
			height: result.height,
		}
	}

	/** @deprecated Use {@link Editor.getSvgString} or {@link Editor.getSvgElement} instead. */
	async getSvg(shapes: TLShapeId[] | TLShape[], opts = {} as Partial<TLSvgOptions>) {
		const result = await this.getSvgElement(shapes, opts)
		if (!result) return undefined
		return result.svg
	}

	/* --------------------- Events --------------------- */

	/**
	 * The app's current input state.
	 *
	 * @public
	 */
	inputs = {
		/** The most recent pointer down's position in the current page space. */
		originPagePoint: new Vec(),
		/** The most recent pointer down's position in screen space. */
		originScreenPoint: new Vec(),
		/** The previous pointer position in the current page space. */
		previousPagePoint: new Vec(),
		/** The previous pointer position in screen space. */
		previousScreenPoint: new Vec(),
		/** The most recent pointer position in the current page space. */
		currentPagePoint: new Vec(),
		/** The most recent pointer position in screen space. */
		currentScreenPoint: new Vec(),
		/** A set containing the currently pressed keys. */
		keys: new Set<string>(),
		/** A set containing the currently pressed buttons. */
		buttons: new Set<number>(),
		/** Whether the input is from a pe. */
		isPen: false,
		/** Whether the shift key is currently pressed. */
		shiftKey: false,
		/** Whether the control or command key is currently pressed. */
		ctrlKey: false,
		/** Whether the alt or option key is currently pressed. */
		altKey: false,
		/** Whether the user is dragging. */
		isDragging: false,
		/** Whether the user is pointing. */
		isPointing: false,
		/** Whether the user is pinching. */
		isPinching: false,
		/** Whether the user is editing. */
		isEditing: false,
		/** Whether the user is panning. */
		isPanning: false,
		/** Velocity of mouse pointer, in pixels per millisecond */
		pointerVelocity: new Vec(),
	}

	/**
	 * Update the input points from a pointer, pinch, or wheel event.
	 *
	 * @param info - The event info.
	 */
	private _updateInputsFromEvent(
		info: TLPointerEventInfo | TLPinchEventInfo | TLWheelEventInfo
	): void {
		const {
			pointerVelocity,
			previousScreenPoint,
			previousPagePoint,
			currentScreenPoint,
			currentPagePoint,
		} = this.inputs

		const { screenBounds } = this.store.unsafeGetWithoutCapture(TLINSTANCE_ID)!
		const { x: cx, y: cy, z: cz } = this.store.unsafeGetWithoutCapture(this.getCameraId())!

		const sx = info.point.x - screenBounds.x
		const sy = info.point.y - screenBounds.y
		const sz = info.point.z ?? 0.5

		previousScreenPoint.setTo(currentScreenPoint)
		previousPagePoint.setTo(currentPagePoint)

		// The "screen bounds" is relative to the user's actual screen.
		// The "screen point" is relative to the "screen bounds";
		// it will be 0,0 when its actual screen position is equal
		// to screenBounds.point. This is confusing!
		currentScreenPoint.set(sx, sy)
		const nx = sx / cz - cx
		const ny = sy / cz - cy
		if (isFinite(nx) && isFinite(ny)) {
			currentPagePoint.set(nx, ny, sz)
		}

		this.inputs.isPen = info.type === 'pointer' && info.isPen

		// Reset velocity on pointer down, or when a pinch starts or ends
		if (info.name === 'pointer_down' || this.inputs.isPinching) {
			pointerVelocity.set(0, 0)
		}

		// todo: We only have to do this if there are multiple users in the document
		this.history.ignore(() => {
			this.store.put([
				{
					id: TLPOINTER_ID,
					typeName: 'pointer',
					x: currentPagePoint.x,
					y: currentPagePoint.y,
					lastActivityTimestamp:
						// If our pointer moved only because we're following some other user, then don't
						// update our last activity timestamp; otherwise, update it to the current timestamp.
						info.type === 'pointer' && info.pointerId === INTERNAL_POINTER_IDS.CAMERA_MOVE
							? this.store.unsafeGetWithoutCapture(TLPOINTER_ID)?.lastActivityTimestamp ??
								this._tickManager.now
							: this._tickManager.now,
					meta: {},
				},
			])
		})
	}

	/**
	 * Dispatch a cancel event.
	 *
	 * @example
	 * ```ts
	 * editor.cancel()
	 * ```
	 *
	 * @public
	 */
	cancel(): this {
		this.dispatch({ type: 'misc', name: 'cancel' })
		return this
	}

	/**
	 * Dispatch an interrupt event.
	 *
	 * @example
	 * ```ts
	 * editor.interrupt()
	 * ```
	 *
	 * @public
	 */
	interrupt(): this {
		this.dispatch({ type: 'misc', name: 'interrupt' })
		return this
	}

	/**
	 * Dispatch a complete event.
	 *
	 * @example
	 * ```ts
	 * editor.complete()
	 * ```
	 *
	 * @public
	 */
	complete(): this {
		this.dispatch({ type: 'misc', name: 'complete' })
		return this
	}

	/**
	 * A manager for recording multiple click events.
	 *
	 * @internal
	 */
	protected _clickManager = new ClickManager(this)

	/**
	 * Prevent a double click event from firing the next time the user clicks
	 *
	 * @public
	 */
	cancelDoubleClick() {
		this._clickManager.cancelDoubleClickTimeout()
	}

	/**
	 * The previous cursor. Used for restoring the cursor after pan events.
	 *
	 * @internal
	 */
	private _prevCursor: TLCursorType = 'default'

	/** @internal */
	private _shiftKeyTimeout = -1 as any

	/** @internal */
	private _setShiftKeyTimeout = () => {
		this.inputs.shiftKey = false
		this.dispatch({
			type: 'keyboard',
			name: 'key_up',
			key: 'Shift',
			shiftKey: this.inputs.shiftKey,
			ctrlKey: this.inputs.ctrlKey,
			altKey: this.inputs.altKey,
			code: 'ShiftLeft',
		})
	}

	/** @internal */
	private _altKeyTimeout = -1 as any

	/** @internal */
	private _setAltKeyTimeout = () => {
		this.inputs.altKey = false
		this.dispatch({
			type: 'keyboard',
			name: 'key_up',
			key: 'Alt',
			shiftKey: this.inputs.shiftKey,
			ctrlKey: this.inputs.ctrlKey,
			altKey: this.inputs.altKey,
			code: 'AltLeft',
		})
	}

	/** @internal */
	private _ctrlKeyTimeout = -1 as any

	/** @internal */
	private _setCtrlKeyTimeout = () => {
		this.inputs.ctrlKey = false
		this.dispatch({
			type: 'keyboard',
			name: 'key_up',
			key: 'Ctrl',
			shiftKey: this.inputs.shiftKey,
			ctrlKey: this.inputs.ctrlKey,
			altKey: this.inputs.altKey,
			code: 'ControlLeft',
		})
	}

	/** @internal */
	private _restoreToolId = 'select'

	/** @internal */
	private _pinchStart = 1

	/** @internal */
	private _didPinch = false

	/** @internal */
	private _selectedShapeIdsAtPointerDown: TLShapeId[] = []

	/** @internal */
	private _longPressTimeout = -1 as any

	/** @internal */
	capturedPointerId: number | null = null

	/**
	 * Dispatch an event to the editor.
	 *
	 * @example
	 * ```ts
	 * editor.dispatch(myPointerEvent)
	 * ```
	 *
	 * @param info - The event info.
	 *
	 * @public
	 */
	dispatch = (info: TLEventInfo): this => {
		this._pendingEventsForNextTick.push(info)
		if (
			!(
				(info.type === 'pointer' && info.name === 'pointer_move') ||
				info.type === 'wheel' ||
				info.type === 'pinch'
			)
		) {
			this._flushEventsForTick(0)
		}
		return this
	}

	private _pendingEventsForNextTick: TLEventInfo[] = []

	private _flushEventsForTick(elapsed: number) {
		this.batch(() => {
			if (this._pendingEventsForNextTick.length > 0) {
				const events = [...this._pendingEventsForNextTick]
				this._pendingEventsForNextTick.length = 0
				for (const info of events) {
					this._flushEventForTick(info)
				}
			}
			if (elapsed > 0) {
				this.root.handleEvent({ type: 'misc', name: 'tick', elapsed })
			}
			this.scribbles.tick(elapsed)
		})
	}

	private _flushEventForTick = (info: TLEventInfo) => {
		// prevent us from spamming similar event errors if we're crashed.
		// todo: replace with new readonly mode?
		if (this.getCrashingError()) return this

		const { inputs } = this
		const { type } = info

		if (info.type === 'misc') {
			// stop panning if the interaction is cancelled or completed
			if (info.name === 'cancel' || info.name === 'complete') {
				this.inputs.isDragging = false

				if (this.inputs.isPanning) {
					this.inputs.isPanning = false
					this.setCursor({ type: this._prevCursor, rotation: 0 })
				}
			}

			this.root.handleEvent(info)
			return
		}

		if (info.shiftKey) {
			clearInterval(this._shiftKeyTimeout)
			this._shiftKeyTimeout = -1
			inputs.shiftKey = true
		} else if (!info.shiftKey && inputs.shiftKey && this._shiftKeyTimeout === -1) {
			this._shiftKeyTimeout = setTimeout(this._setShiftKeyTimeout, 150)
		}

		if (info.altKey) {
			clearInterval(this._altKeyTimeout)
			this._altKeyTimeout = -1
			inputs.altKey = true
		} else if (!info.altKey && inputs.altKey && this._altKeyTimeout === -1) {
			this._altKeyTimeout = setTimeout(this._setAltKeyTimeout, 150)
		}

		if (info.ctrlKey) {
			clearInterval(this._ctrlKeyTimeout)
			this._ctrlKeyTimeout = -1
			inputs.ctrlKey = true /** @internal */ /** @internal */ /** @internal */
		} else if (!info.ctrlKey && inputs.ctrlKey && this._ctrlKeyTimeout === -1) {
			this._ctrlKeyTimeout = setTimeout(this._setCtrlKeyTimeout, 150)
		}

		const { originPagePoint, originScreenPoint, currentPagePoint, currentScreenPoint } = inputs

		if (!inputs.isPointing) {
			inputs.isDragging = false
		}

		switch (type) {
			case 'pinch': {
				if (!this.getInstanceState().canMoveCamera) return
				clearTimeout(this._longPressTimeout)
				this._updateInputsFromEvent(info)

				switch (info.name) {
					case 'pinch_start': {
						if (inputs.isPinching) return

						if (!inputs.isEditing) {
							this._pinchStart = this.getCamera().z
							if (!this._selectedShapeIdsAtPointerDown.length) {
								this._selectedShapeIdsAtPointerDown = this.getSelectedShapeIds()
							}

							this._didPinch = true

							inputs.isPinching = true

							this.interrupt()
						}

						return // Stop here!
					}
					case 'pinch': {
						if (!inputs.isPinching) return

						const {
							point: { z = 1 },
							delta: { x: dx, y: dy },
						} = info

						const { screenBounds } = this.store.unsafeGetWithoutCapture(TLINSTANCE_ID)!
						const { x, y } = Vec.SubXY(info.point, screenBounds.x, screenBounds.y)

						const { x: cx, y: cy, z: cz } = this.getCamera()

						const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

						this.stopCameraAnimation()
						if (this.getInstanceState().followingUserId) {
							this.stopFollowingUser()
						}
						this._setCamera(
							{
								x: cx + dx / cz - x / cz + x / zoom,
								y: cy + dy / cz - y / cz + y / zoom,
								z: zoom,
							},
							true
						)

						return // Stop here!
					}
					case 'pinch_end': {
						if (!inputs.isPinching) return this

						inputs.isPinching = false
						const { _selectedShapeIdsAtPointerDown } = this
						this.setSelectedShapes(this._selectedShapeIdsAtPointerDown)
						this._selectedShapeIdsAtPointerDown = []

						if (this._didPinch) {
							this._didPinch = false
							this.once('tick', () => {
								if (!this._didPinch) {
									this.setSelectedShapes(_selectedShapeIdsAtPointerDown)
								}
							})
						}

						return // Stop here!
					}
				}
			}
			case 'wheel': {
				if (!this.getInstanceState().canMoveCamera) return

				this._updateInputsFromEvent(info)

				if (this.getIsMenuOpen()) {
					// noop
				} else {
					this.stopCameraAnimation()
					if (this.getInstanceState().followingUserId) {
						this.stopFollowingUser()
					}
					if (inputs.ctrlKey) {
						// todo: Start or update the zoom end interval

						// If the alt or ctrl keys are pressed,
						// zoom or pan the camera and then return.

						// Subtract the top left offset from the user's point

						const { x, y } = this.inputs.currentScreenPoint

						const { x: cx, y: cy, z: cz } = this.getCamera()

						const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cz + (info.delta.z ?? 0) * cz))

						this._setCamera(
							{
								x: cx + (x / zoom - x) - (x / cz - x),
								y: cy + (y / zoom - y) - (y / cz - y),
								z: zoom,
							},
							true
						)

						// We want to return here because none of the states in our
						// statechart should respond to this event (a camera zoom)
						return
					}

					// Update the camera here, which will dispatch a pointer move...
					// this will also update the pointer position, etc
					const { x: cx, y: cy, z: cz } = this.getCamera()
					this._setCamera({ x: cx + info.delta.x / cz, y: cy + info.delta.y / cz, z: cz }, true)

					if (
						!inputs.isDragging &&
						inputs.isPointing &&
						Vec.Dist2(originPagePoint, currentPagePoint) >
							(this.getInstanceState().isCoarsePointer ? COARSE_DRAG_DISTANCE : DRAG_DISTANCE) /
								this.getZoomLevel()
					) {
						clearTimeout(this._longPressTimeout)
						inputs.isDragging = true
					}
				}
				break
			}
			case 'pointer': {
				// If we're pinching, return
				if (inputs.isPinching) return

				this._updateInputsFromEvent(info)

				const { isPen } = info

				switch (info.name) {
					case 'pointer_down': {
						this.clearOpenMenus()

						this._longPressTimeout = setTimeout(() => {
							this.dispatch({ ...info, name: 'long_press' })
						}, LONG_PRESS_DURATION)

						this._selectedShapeIdsAtPointerDown = this.getSelectedShapeIds()

						// Firefox bug fix...
						// If it's a left-mouse-click, we store the pointer id for later user
						if (info.button === 0) {
							this.capturedPointerId = info.pointerId
						}

						// Add the button from the buttons set
						inputs.buttons.add(info.button)

						inputs.isPointing = true
						inputs.isDragging = false

						if (this.getInstanceState().isPenMode) {
							if (!isPen) {
								return
							}
						} else {
							if (isPen) {
								this.updateInstanceState({ isPenMode: true })
							}
						}

						if (info.button === 5) {
							// Eraser button activates eraser
							this._restoreToolId = this.getCurrentToolId()
							this.complete()
							this.setCurrentTool('eraser')
						} else if (info.button === 1) {
							// Middle mouse pan activates panning
							if (!this.inputs.isPanning) {
								this._prevCursor = this.getInstanceState().cursor.type
							}

							this.inputs.isPanning = true
						}

						if (this.inputs.isPanning) {
							this.stopCameraAnimation()
							this.setCursor({ type: 'grabbing', rotation: 0 })
							return this
						}

						originScreenPoint.setTo(currentScreenPoint)
						originPagePoint.setTo(currentPagePoint)
						break
					}
					case 'pointer_move': {
						// If the user is in pen mode, but the pointer is not a pen, stop here.
						if (!isPen && this.getInstanceState().isPenMode) {
							return
						}

						if (this.inputs.isPanning && this.inputs.isPointing) {
							clearTimeout(this._longPressTimeout)
							// Handle panning
							const { currentScreenPoint, previousScreenPoint } = this.inputs
							this.pan(Vec.Sub(currentScreenPoint, previousScreenPoint))
							return
						}

						if (
							!inputs.isDragging &&
							inputs.isPointing &&
							Vec.Dist2(originPagePoint, currentPagePoint) >
								(this.getInstanceState().isCoarsePointer ? COARSE_DRAG_DISTANCE : DRAG_DISTANCE) /
									this.getZoomLevel()
						) {
							clearTimeout(this._longPressTimeout)
							inputs.isDragging = true
						}
						break
					}
					case 'pointer_up': {
						// Remove the button from the buttons set
						inputs.buttons.delete(info.button)

						inputs.isPointing = false
						inputs.isDragging = false

						if (this.getIsMenuOpen()) {
							// Suppressing pointerup here as <ContextMenu/> doesn't seem to do what we what here.
							return
						}

						if (!isPen && this.getInstanceState().isPenMode) {
							return
						}

						// Firefox bug fix...
						// If it's the same pointer that we stored earlier...
						// ... then it's probably still a left-mouse-click!
						if (this.capturedPointerId === info.pointerId) {
							this.capturedPointerId = null
							info.button = 0
						}

						if (inputs.isPanning) {
							if (info.button === 1) {
								if (!this.inputs.keys.has(' ')) {
									inputs.isPanning = false

									this.slideCamera({
										speed: Math.min(2, this.inputs.pointerVelocity.len()),
										direction: this.inputs.pointerVelocity,
										friction: CAMERA_SLIDE_FRICTION,
									})
									this.setCursor({ type: this._prevCursor, rotation: 0 })
								} else {
									this.slideCamera({
										speed: Math.min(2, this.inputs.pointerVelocity.len()),
										direction: this.inputs.pointerVelocity,
										friction: CAMERA_SLIDE_FRICTION,
									})
									this.setCursor({
										type: 'grab',
										rotation: 0,
									})
								}
							} else if (info.button === 0) {
								this.slideCamera({
									speed: Math.min(2, this.inputs.pointerVelocity.len()),
									direction: this.inputs.pointerVelocity,
									friction: CAMERA_SLIDE_FRICTION,
								})
								this.setCursor({
									type: 'grab',
									rotation: 0,
								})
							}
						} else {
							if (info.button === 5) {
								// Eraser button activates eraser
								this.complete()
								this.setCurrentTool(this._restoreToolId)
							}
						}

						break
					}
				}

				break
			}
			case 'keyboard': {
				// please, please
				if (info.key === 'ShiftRight') info.key = 'ShiftLeft'
				if (info.key === 'AltRight') info.key = 'AltLeft'
				if (info.code === 'ControlRight') info.code = 'ControlLeft'

				switch (info.name) {
					case 'key_down': {
						// Add the key from the keys set
						inputs.keys.add(info.code)

						// If the space key is pressed (but meta / control isn't!) activate panning
						if (!info.ctrlKey && info.code === 'Space') {
							if (!this.inputs.isPanning) {
								this._prevCursor = this.getInstanceState().cursor.type
							}

							this.inputs.isPanning = true
							this.setCursor({ type: this.inputs.isPointing ? 'grabbing' : 'grab', rotation: 0 })
						}

						break
					}
					case 'key_up': {
						// Remove the key from the keys set
						inputs.keys.delete(info.code)

						if (info.code === 'Space' && !this.inputs.buttons.has(1)) {
							this.inputs.isPanning = false
							this.setCursor({ type: this._prevCursor, rotation: 0 })
						}

						break
					}
					case 'key_repeat': {
						// noop
						break
					}
				}
				break
			}
		}

		// Correct the info name for right / middle clicks
		if (info.type === 'pointer') {
			if (info.button === 1) {
				info.name = 'middle_click'
			} else if (info.button === 2) {
				info.name = 'right_click'
			}

			// If a pointer event, send the event to the click manager.
			if (info.isPen === this.getInstanceState().isPenMode) {
				switch (info.name) {
					case 'pointer_down': {
						const otherEvent = this._clickManager.transformPointerDownEvent(info)
						if (info.name !== otherEvent.name) {
							this.root.handleEvent(info)
							this.emit('event', info)
							this.root.handleEvent(otherEvent)
							this.emit('event', otherEvent)
							return
						}

						break
					}
					case 'pointer_up': {
						clearTimeout(this._longPressTimeout)

						const otherEvent = this._clickManager.transformPointerUpEvent(info)
						if (info.name !== otherEvent.name) {
							this.root.handleEvent(info)
							this.emit('event', info)
							this.root.handleEvent(otherEvent)
							this.emit('event', otherEvent)
							return
						}

						break
					}
					case 'pointer_move': {
						this._clickManager.handleMove()
						break
					}
				}
			}
		}

		// Send the event to the statechart. It will be handled by all
		// active states, starting at the root.
		this.root.handleEvent(info)
		this.emit('event', info)

		return this
	}
}

function alertMaxShapes(editor: Editor, pageId = editor.getCurrentPageId()) {
	const name = editor.getPage(pageId)!.name
	editor.emit('max-shapes', { name, pageId, count: MAX_SHAPES_PER_PAGE })
}

function applyPartialToShape<T extends TLShape>(prev: T, partial?: TLShapePartial<T>): T {
	if (!partial) return prev
	let next = null as null | T
	const entries = Object.entries(partial)
	for (let i = 0, n = entries.length; i < n; i++) {
		const [k, v] = entries[i]
		if (v === undefined) continue

		// Is the key a special key? We don't update those
		if (k === 'id' || k === 'type' || k === 'typeName') continue

		// Is the value the same as it was before?
		if (v === (prev as any)[k]) continue

		// There's a new value, so create the new shape if we haven't already (should we be cloning this?)
		if (!next) next = { ...prev }

		// for props / meta properties, we support updates with partials of this object
		if (k === 'props' || k === 'meta') {
			next[k] = { ...prev[k] } as JsonObject
			for (const [nextKey, nextValue] of Object.entries(v as object)) {
				if (nextValue !== undefined) {
					;(next[k] as JsonObject)[nextKey] = nextValue
				}
			}
			continue
		}

		// base property
		;(next as any)[k] = v
	}
	if (!next) return prev
	return next
}

function pushShapeWithDescendants(editor: Editor, id: TLShapeId, result: TLShape[]): void {
	const shape = editor.getShape(id)
	if (!shape) return
	result.push(shape)
	const childIds = editor.getSortedChildIdsForParent(id)
	for (let i = 0, n = childIds.length; i < n; i++) {
		pushShapeWithDescendants(editor, childIds[i], result)
	}
}
