export type LabelBox = [number, number, number, number];

const overlaps = (a: LabelBox, b: LabelBox) =>
  a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

export function placeLabel(anchor: [number, number], size: [number, number],
                           occupied: LabelBox[], bounds: LabelBox) {
  const [x, y] = anchor, [width, height] = size;
  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));

  for (let ring = 0; ring < 64; ring++) {
    const row = Math.ceil(ring / 2);
    const dy = (ring === 0 ? 0 : ring % 2 ? row : -row) * (height + 4);
    for (const side of [1, -1]) {
      const left = clamp(x + (side > 0 ? 9 : -width - 9),
        bounds[0], bounds[2] - width);
      const top = clamp(y - height / 2 + dy, bounds[1], bounds[3] - height);
      const box: LabelBox = [left, top, left + width, top + height];
      if (!occupied.some((other) => overlaps(box, other))) {
        occupied.push(box);
        return box;
      }
    }
  }

  const box: LabelBox = [x + 9, y - height / 2, x + width + 9, y + height / 2];
  occupied.push(box);
  return box;
}
