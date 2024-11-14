import { Box, Vec } from 'tldraw'

export interface ArrowNavigationGrid {
	// First box bounds
	A: {
		box: Box
		// center of box
		c: Vec
		// expanded bounds
		e: {
			// edges
			t: Vec
			r: Vec
			b: Vec
			l: Vec
			// corners
			tl: Vec
			tr: Vec
			br: Vec
			bl: Vec
		}
		// edges
		t: Vec
		r: Vec
		b: Vec
		l: Vec
	}
	// Second box bounds
	B: {
		box: Box
		// center of box
		c: Vec
		// expanded bounds
		e: {
			// edges
			t: Vec
			r: Vec
			b: Vec
			l: Vec
			// corners
			tl: Vec
			tr: Vec
			br: Vec
			bl: Vec
		}
		// edges
		t: Vec
		r: Vec
		b: Vec
		l: Vec
	}
	// Bounds from centers of A and B
	C: {
		// center
		c: Vec
		// edges
		t: Vec
		r: Vec
		b: Vec
		l: Vec
		// corners
		tr: Vec
		tl: Vec
		br: Vec
		bl: Vec
	}
	// Outer bounds of shapes
	D: {
		// center
		c: Vec
		// corners
		tr: Vec
		tl: Vec
		br: Vec
		bl: Vec
		// Intersection points from corners of C on edges of D
		// top mid of c on top edge of d
		tc: Vec
		// right mid of c on right edge of d
		rc: Vec
		// bottom mid of c on bottom edge of d
		bc: Vec
		// left mid of c on left edge of d
		lc: Vec
		// left side of top edge
		tcl: Vec
		// right side of top edge
		tcr: Vec
		// top side of right edge
		rct: Vec
		// bottom side of right edge
		rcb: Vec
		// right side of bottom edge
		bcr: Vec
		// left side of bottom edge
		bcl: Vec
		// bottom side of left edge
		lcb: Vec
		// top side of left edge
		lct: Vec
	}
	gap: {
		h: Box
		v: Box
		o: Box
		c: Vec
	}
}

export function getArrowNavigationGrid(A: Box, B: Box, expand: number): ArrowNavigationGrid {
	const AE = A.clone().expandBy(expand)
	const BE = B.clone().expandBy(expand)
	const C = Box.FromPoints([A.center, B.center])
	const D = Box.Common([A, B]).expandBy(expand)

	// are A and B disjoint on the x axis, and if so, what's min and max?

	let gapX: number, gapY: number, mx: number, my: number

	if (A.maxX < B.minX) {
		// range a is to the left of range b
		gapX = B.minX - A.maxX
		mx = A.maxX + gapX / 2
	} else if (A.minX > B.maxX) {
		// range a is to the right of range b
		gapX = A.minX - B.maxX
		mx = B.maxX + gapX / 2
	} else if (A.maxX > B.maxX && A.minX < B.minX) {
		// a contains whole B range
		gapX = Math.abs(B.maxX - B.minX)
		mx = B.center.x
	} else if (B.maxX >= A.maxX && B.minX <= A.minX) {
		// b contains whole A range
		gapX = Math.abs(A.maxX - A.minX)
		mx = A.center.x
	} else if (B.maxX >= A.maxX && B.minX <= A.maxX) {
		// b overlaps A right
		gapX = A.maxX - B.minX
		mx = B.minX + gapX / 2
	} else if (B.minX <= A.minX && B.maxX >= A.minX) {
		// b overlaps A left
		gapX = B.maxX - A.minX
		mx = A.minX + gapX / 2
	} else {
		throw Error()
	}

	if (A.maxY < B.minY) {
		// range a is above range b
		gapY = B.minY - A.maxY
		my = A.maxY + gapY / 2
	} else if (A.minY > B.maxY) {
		// range a is below range b
		gapY = A.minY - B.maxY
		my = B.maxY + gapY / 2
	} else if (A.maxY > B.maxY && A.minY < B.minY) {
		// a contains whole B range
		gapY = Math.abs(B.maxY - B.minY)
		my = B.center.y
	} else if (B.maxY >= A.maxY && B.minY <= A.minY) {
		// b contains whole A range
		gapY = Math.abs(A.maxY - A.minY)
		my = A.center.y
	} else if (B.maxY >= A.maxY && B.minY <= A.maxY) {
		// b overlaps A bottom
		gapY = A.maxY - B.minY
		my = B.minY + gapY / 2
	} else if (B.minY <= A.minY && B.maxY >= A.minY) {
		// b overlaps A top
		gapY = B.maxY - A.minY
		my = A.minY + gapY / 2
	} else {
		throw Error()
	}

	const g = {
		A: {
			box: A,
			c: A.center,
			t: new Vec(A.midX, A.minY),
			r: new Vec(A.maxX, A.midY),
			b: new Vec(A.midX, A.maxY),
			l: new Vec(A.minX, A.midY),
			e: {
				t: new Vec(AE.midX, AE.minY),
				r: new Vec(AE.maxX, AE.midY),
				b: new Vec(AE.midX, AE.maxY),
				l: new Vec(AE.minX, AE.midY),
				tl: new Vec(AE.minX, AE.minY),
				tr: new Vec(AE.maxX, AE.minY),
				br: new Vec(AE.maxX, AE.maxY),
				bl: new Vec(AE.minX, AE.maxY),
			},
		},
		B: {
			box: B,
			c: B.center,
			t: new Vec(B.midX, B.minY),
			r: new Vec(B.maxX, B.midY),
			b: new Vec(B.midX, B.maxY),
			l: new Vec(B.minX, B.midY),
			e: {
				t: new Vec(BE.midX, BE.minY),
				r: new Vec(BE.maxX, BE.midY),
				b: new Vec(BE.midX, BE.maxY),
				l: new Vec(BE.minX, BE.midY),
				tl: new Vec(BE.minX, BE.minY),
				tr: new Vec(BE.maxX, BE.minY),
				br: new Vec(BE.maxX, BE.maxY),
				bl: new Vec(BE.minX, BE.maxY),
			},
		},
		C: {
			c: new Vec(mx, my),
			t: new Vec(mx, C.minY),
			r: new Vec(C.maxX, my),
			b: new Vec(mx, C.maxY),
			l: new Vec(C.minX, my),
			tl: new Vec(C.minX, C.minY),
			tr: new Vec(C.maxX, C.minY),
			br: new Vec(C.maxX, C.maxY),
			bl: new Vec(C.minX, C.maxY),
		},
		D: {
			c: D.center,
			tl: new Vec(D.minX, D.minY),
			tr: new Vec(D.maxX, D.minY),
			br: new Vec(D.maxX, D.maxY),
			bl: new Vec(D.minX, D.maxY),
			tcl: new Vec(C.minX, D.minY),
			tcr: new Vec(C.maxX, D.minY),
			rct: new Vec(D.maxX, C.minY),
			rcb: new Vec(D.maxX, C.maxY),
			bcr: new Vec(C.maxX, D.maxY),
			bcl: new Vec(C.minX, D.maxY),
			lcb: new Vec(D.minX, C.maxY),
			lct: new Vec(D.minX, C.minY),
			tc: new Vec(mx, D.minY),
			rc: new Vec(D.maxX, my),
			bc: new Vec(mx, D.maxY),
			lc: new Vec(D.minX, my),
		},
		gap: {
			h: Box.FromPoints([new Vec(mx - gapX / 2, D.minY), new Vec(mx + gapX / 2, D.maxY)]),
			v: Box.FromPoints([new Vec(D.minX, my - gapY / 2), new Vec(D.maxX, my + gapY / 2)]),
			o: Box.FromPoints([
				new Vec(mx - gapX / 2, my - gapY / 2),
				new Vec(mx + gapX / 2, my + gapY / 2),
			]),
			c: new Vec(mx, my),
		},

		// edge to start from

		// set of banned vectors (points on C or D that are contained in Ae or Be)
	}

	return g
}
