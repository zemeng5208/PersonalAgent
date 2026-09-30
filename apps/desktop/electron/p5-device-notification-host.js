/** Native show acknowledgement is delivery proof. A saved panel card is only intent. */
export function createP5DeviceNotificationHost({Notification, store, readProvenance, isActive,
  onUpdate = () => {}, onLateOutcome = async () => {}, timeoutMs = 5000} = {}) {
  if (typeof Notification !== 'function' || typeof Notification.isSupported !== 'function'
    || !store || typeof store.recordDelivery !== 'function' || typeof readProvenance !== 'function'
    || typeof isActive !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Invalid P5 notification host');
  }
  const active = new Map();
  let disposed = false;
  return Object.freeze({
    async sendAdvisoryNotification(notification) {
      if (disposed || !isActive()) return {delivered: false};
      const provenance = readProvenance(notification);
      if (!provenance) return {delivered: false};
      const saved = store.addNotification(notification, provenance);
      onUpdate();
      if (saved.duplicate) {
        if (active.has(notification.id)) return active.get(notification.id).promise;
        if (saved.record.deliveryState === 'unknown' || saved.record.deliveryState === 'pending') {
          throw new Error('P5 notification delivery requires reconciliation');
        }
        return {delivered: saved.record.deliveryState === 'delivered'};
      }
      if (!Notification.isSupported()) {
        store.recordDelivery(notification.id, 'failed');
        onUpdate();
        return {delivered: false};
      }
      let native;
      try { native = new Notification({title: notification.title,
        body: `${notification.message}\n${notification.advice}`}); }
      catch { store.recordDelivery(notification.id, 'failed'); onUpdate(); return {delivered: false}; }
      let settled = false;
      let resolveResult, rejectResult;
      const promise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      const detach = () => {
        clearTimeout(timer);
        native.removeListener('show', shown);
        native.removeListener('failed', failed);
        active.delete(notification.id);
      };
      const finish = delivered => {
        const late = settled;
        try { store.recordDelivery(notification.id, delivered ? 'delivered' : 'failed'); }
        catch { unknown(); return; }
        detach();
        settled = true;
        onUpdate();
        if (late) Promise.resolve().then(() => onLateOutcome(notification.source, notification.id, delivered)).catch(() => {});
        else resolveResult({delivered});
      };
      const shown = () => finish(true);
      const failed = () => finish(false);
      const unknown = () => {
        try { store.recordDelivery(notification.id, 'unknown'); } catch {}
        clearTimeout(timer);
        onUpdate();
        if (!settled) { settled = true; rejectResult(new Error('P5 notification delivery is unknown')); }
      };
      const timer = setTimeout(unknown, timeoutMs);
      native.once('show', shown);
      native.once('failed', failed);
      active.set(notification.id, {promise, stop() { unknown(); detach(); }});
      try { native.show(); } catch { unknown(); detach(); }
      return promise;
    },
    dispose() {
      disposed = true;
      for (const item of [...active.values()]) item.stop();
    },
  });
}
