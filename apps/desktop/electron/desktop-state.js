import {mkdirSync, readFileSync, writeFileSync, renameSync} from 'node:fs';
import path from 'node:path';

export const defaults = {theme: 'system', language: 'system', fontScale: 1, calm: false, alwaysOnTop: true, snap: true, hover: true, shortcut: false};
export function normalizeSettings(value = {}) {
  const result = {...defaults};
  for (const key of ['calm', 'alwaysOnTop', 'snap', 'hover', 'shortcut']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (['system', 'light', 'dark'].includes(value.theme)) result.theme = value.theme;
  if (['system', 'zh-CN', 'en'].includes(value.language)) result.language = value.language;
  if ([0.9, 1, 1.1, 1.2, 1.3].includes(value.fontScale)) result.fontScale = value.fontScale;
  return result;
}
export function fitBounds(bounds, area) {
  const width = Math.min(Math.max(1, Math.round(bounds.width)), area.width);
  const height = Math.min(Math.max(1, Math.round(bounds.height)), area.height);
  return {width, height, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)))};
}
export function snapBounds(bounds, area, distance = 24) {
  const fitted = fitBounds(bounds, area);
  for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
    const end = area[axis] + area[size] - fitted[size];
    if (Math.abs(fitted[axis] - area[axis]) <= distance) fitted[axis] = area[axis];
    else if (Math.abs(fitted[axis] - end) <= distance) fitted[axis] = end;
  }
  return fitted;
}
export class DesktopState {
  constructor(file) {
    this.file = file;
    this.value = {settings: {...defaults}, windows: {}};
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      this.value.settings = normalizeSettings(saved.settings);
      for (const [key, bounds] of Object.entries(saved.windows ?? {})) {
        if (['orb', 'admin', 'workspace', 'desktop-settings'].includes(key) && bounds && ['x', 'y', 'width', 'height'].every(field => Number.isFinite(bounds[field])) && bounds.width > 0 && bounds.height > 0) this.value.windows[key] = bounds;
      }
    } catch { /* Missing or damaged preferences use safe defaults. */ }
  }
  save() {
    mkdirSync(path.dirname(this.file), {recursive: true});
    writeFileSync(this.file + '.tmp', JSON.stringify(this.value), 'utf8');
    renameSync(this.file + '.tmp', this.file);
  }
  update(patch) { this.value.settings = normalizeSettings({...this.value.settings, ...patch}); this.save(); return {...this.value.settings}; }
  remember(key, bounds) { this.value.windows[key] = bounds; this.save(); }
}
