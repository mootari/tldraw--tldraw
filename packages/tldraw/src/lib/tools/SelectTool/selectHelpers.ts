import {
	Box,
	Editor,
	Geometry2d,
	Mat,
	TLShape,
	TLShapeId,
	Vec,
	canonicalizeRotation,
	compact,
	pointInPolygon,
	polygonIntersectsPolyline,
	polygonsIntersect,
} from '@tldraw/editor'
import { getLabelSide } from '../../shapes/frame/components/FrameHeading'

/** @internal */
export function kickoutOccludedShapes(editor: Editor, shapeIds: TLShapeId[]) {
	// const shapes = shapeIds.map((id) => editor.getShape(id)).filter((s) => s) as TLShape[]
	const parentsToCheck = new Set<TLShape>()
	for (const id of shapeIds) {
		// If the shape exists and the shape has an onDragShapesOut
		// function, add it to the set
		const shape = editor.getShape(id)
		if (!shape) continue
		if (editor.getShapeUtil(shape).onDragShapesOut) {
			parentsToCheck.add(shape)
		}
		// If the shape's parent is a shape and the shape's parent
		// has an onDragShapesOut function, add it to the set
		const parent = editor.getShape(shape.parentId)
		if (!parent) continue
		if (editor.getShapeUtil(parent).onDragShapesOut) {
			parentsToCheck.add(parent)
		}
	}

	const parentsWithKickedOutChildren = new Map<TLShape, TLShapeId[]>()

	for (const parent of parentsToCheck) {
		const occludedChildren = getOccludedChildren(editor, parent)
		if (occludedChildren.length) {
			parentsWithKickedOutChildren.set(parent, occludedChildren)
		}
	}

	// now call onDragShapesOut for each parent
	for (const [parent, kickedOutChildrenIds] of parentsWithKickedOutChildren) {
		const shapeUtil = editor.getShapeUtil(parent)
		const kickedOutChildren = compact(kickedOutChildrenIds.map((id) => editor.getShape(id)))
		shapeUtil.onDragShapesOut?.(parent, kickedOutChildren)
	}
}

/** @public */
export function getOccludedChildren(editor: Editor, parent: TLShape) {
	const childIds = editor.getSortedChildIdsForParent(parent.id)
	if (childIds.length === 0) return []
	const parentPageBounds = editor.getShapePageBounds(parent)
	if (!parentPageBounds) return []

	let parentGeometry: Geometry2d | undefined
	let parentPageTransform: Mat | undefined
	let parentPageCorners: Vec[] | undefined

	const results: TLShapeId[] = []

	for (const childId of childIds) {
		const shapePageBounds = editor.getShapePageBounds(childId)
		if (!shapePageBounds) {
			// Not occluded, shape doesn't exist
			continue
		}

		if (!parentPageBounds.includes(shapePageBounds)) {
			// Not in shape's bounds, shape is occluded
			results.push(childId)
			continue
		}

		// There might be a lot of children; we don't want to do this for all of them,
		// but we also don't want to do it at all if we don't have to. ??= to the rescue!

		parentGeometry ??= editor.getShapeGeometry(parent)
		parentPageTransform ??= editor.getShapePageTransform(parent)
		parentPageCorners ??= parentPageTransform.applyToPoints(parentGeometry.vertices)

		const parentCornersInShapeSpace = editor
			.getShapePageTransform(childId)
			.clone()
			.invert()
			.applyToPoints(parentPageCorners)

		// If any of the shape's vertices are inside the occluder, it's not occluded
		const { vertices, isClosed } = editor.getShapeGeometry(childId)

		if (vertices.some((v) => pointInPolygon(v, parentCornersInShapeSpace))) {
			// not occluded, vertices are in the occluder's corners
			continue
		}

		// If any the shape's vertices intersect the edge of the occluder, it's not occluded
		if (isClosed) {
			if (polygonsIntersect(parentCornersInShapeSpace, vertices)) {
				// not occluded, vertices intersect parent's corners
				continue
			}
		} else if (polygonIntersectsPolyline(parentCornersInShapeSpace, vertices)) {
			// not occluded, vertices intersect parent's corners
			continue
		}

		// Passed all checks, shape is occluded
		results.push(childId)
	}

	return results
}

/** @internal */
export function startEditingShapeWithLabel(editor: Editor, shape: TLShape, selectAll = false) {
	// Finish this shape and start editing the next one
	editor.select(shape)
	editor.setEditingShape(shape)
	editor.setCurrentTool('select.editing_shape', {
		target: 'shape',
		shape: shape,
	})
	if (selectAll) {
		editor.emit('select-all-text', { shapeId: shape.id })
	}
	// zoomToShapeIfOffscreen(editor)
	zoomToLabelPosition(editor)
}

const ZOOM_TO_SHAPE_PADDING = 16
export function zoomToShapeIfOffscreen(editor: Editor) {
	const selectionPageBounds = editor.getSelectionPageBounds()
	const viewportPageBounds = editor.getViewportPageBounds()
	if (selectionPageBounds && !viewportPageBounds.contains(selectionPageBounds)) {
		const eb = selectionPageBounds
			.clone()
			// Expand the bounds by the padding
			.expandBy(ZOOM_TO_SHAPE_PADDING / editor.getZoomLevel())
			// then expand the bounds to include the viewport bounds
			.expand(viewportPageBounds)

		// then use the difference between the centers to calculate the offset
		const nextBounds = viewportPageBounds.clone().translate({
			x: (eb.center.x - viewportPageBounds.center.x) * 2,
			y: (eb.center.y - viewportPageBounds.center.y) * 2,
		})
		editor.zoomToBounds(nextBounds, {
			animation: {
				duration: editor.options.animationMediumMs,
			},
			inset: 0,
		})
	}
}
function zoomToLabelPosition(editor: Editor) {
	// get the geometry of the label
	let labelBox: Box
	const shape = editor.getEditingShape()!
	const transform = editor.getShapePageTransform(shape)
	if (shape.type === 'frame') {
		const FRAME_HEADING_HEIGHT = 32
		const frameGeometry = editor.getShapeGeometry(shape)!
		//todo : make a function that both frameheading component and this function use

		// which side is the frame heading on?
		const pageRotation = canonicalizeRotation(transform.rotation())
		const labelSide = getLabelSide(pageRotation)

		// scale with zoom
		const zoomAdjustedHeight = FRAME_HEADING_HEIGHT * editor.getZoomLevel()

		const [one, two, three, four] = frameGeometry.getVertices()

		let angle: Vec
		let startPoint: Vec
		switch (labelSide) {
			case 'top':
				angle = Vec.Sub(one, four).uni()
				startPoint = one
				break
			case 'left':
				angle = Vec.Sub(four, three).uni()
				startPoint = four
				break
			case 'bottom':
				angle = Vec.Sub(three, two).uni()
				startPoint = three
				break
			case 'right':
				angle = Vec.Sub(two, one).uni()
				startPoint = two
				break
		}
		const frameHeadingPoint = Vec.Add(startPoint, angle.mul(zoomAdjustedHeight))

		const inPageSpace = transform.applyToPoint(frameHeadingPoint)

		labelBox = new Box(inPageSpace.x, inPageSpace.y, 4, 4)
	} else {
		const labelGeometry = editor
			.getShapeGeometry(shape)
			// @ts-ignore
			.children.filter((g: Geometry2d) => g.isLabel === true)[0]
		const pagePoint = transform.applyToPoint(
			new Vec(labelGeometry.bounds.minX, labelGeometry.bounds.minY)
		)
		labelBox = new Box(
			pagePoint.x,
			pagePoint.y,
			labelGeometry.bounds.width,
			labelGeometry.bounds.height
		)
	}

	// zoom to the start of the label
	const viewportPageBounds = editor.getViewportPageBounds()
	if (labelBox && !viewportPageBounds.contains(labelBox)) {
		// todo: Avoid collisions with menus also when zooming to things at the bottom of the screen it should contain the whole label
		const eb = labelBox
			.clone()
			// Expand the bounds by the padding
			.expandBy(ZOOM_TO_SHAPE_PADDING / editor.getZoomLevel())
			// then expand the bounds to include the viewport bounds
			.expand(viewportPageBounds)

		// then use the difference between the centers to calculate the offset
		const nextBounds = viewportPageBounds.clone().translate({
			x: (eb.center.x - viewportPageBounds.center.x) * 2,
			y: (eb.center.y - viewportPageBounds.center.y) * 2,
		})
		editor.zoomToBounds(nextBounds, {
			animation: {
				duration: editor.options.animationMediumMs,
			},
			inset: 0,
		})
	}
}
