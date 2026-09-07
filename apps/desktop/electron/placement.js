export function panelBounds(orb, area) {
  const width = Math.min(420, area.width);
  const height = Math.min(640, area.height);
  const right = orb.x + orb.width + 8;
  const x = right + width <= area.x + area.width ? right : orb.x - width - 8;
  return { x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(orb.y - 60, area.y + area.height - height))), width, height };
}
export function clampOrb(bounds, area) {
  return { ...bounds, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height))) };
}

export function draggedGroupBounds(orbStart, pointerStart, pointer, area) {
  const orb = clampOrb({
    ...orbStart,
    x: orbStart.x + pointer.x - pointerStart.x,
    y: orbStart.y + pointer.y - pointerStart.y,
  }, area);
  return {orb, panel: panelBounds(orb, area)};
}
