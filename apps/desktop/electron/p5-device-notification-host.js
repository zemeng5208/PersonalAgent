/** Native show acknowledgement is delivery proof. A saved panel card is only intent. */
export function createP5DeviceNotificationHost({Notification, store, readProvenance, isActive,
  readDeliveryPolicy = () => ({allowed: false, reason: 'unavailable'}),
  onUpdate = () => {}, onLateOutcome = async () => {}, timeoutMs = 5000} = {}) {
  if (typeof Notification !== 'function' || typeof Notification.isSupported !== 'function'
    || !store || typeof store.recordDelivery !== 'function' || typeof store.addNotification !== 'function'
    || typeof store.read !== 'function' || typeof readProvenance !== 'function' || typeof isActive !== 'function'
    || typeof readDeliveryPolicy !== 'function'
    || typeof onUpdate !== 'function' || typeof onLateOutcome !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Invalid P5 notification host');
  }
  const active = new Map();
  let disposed = false;
  let generation = 0;
  const publish = () => { if (!disposed) { try { onUpdate(); } catch {} } };
  const policy = () => {
    try {
      const value = readDeliveryPolicy();
      if (value && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value))
        && Object.keys(value).every(key => ['allowed', 'reason'].includes(key))) {
        if (value.allowed === true && (value.reason === undefined || value.reason === null)) return value;
        if (value.allowed === false && ['quiet_hours', 'paused', 'unavailable'].includes(value.reason)) return value;
      }
    } catch {}
    return {allowed: false, reason: 'unavailable'};
  };
  const stop = () => {
    generation++;
    for (const item of [...active.values()]) item.stop();
  };
  return Object.freeze({
    async sendAdvisoryNotification(notification) {
      if (disposed || !isActive()) return {delivered: false};
      const sendGeneration = generation;
      const provenance = readProvenance(notification);
      if (!provenance) return {delivered: false};
      const authorized = () => {
        try { return !disposed && generation === sendGeneration && isActive() && Boolean(readProvenance(notification)); }
        catch { return false; }
      };
      // Quiet time is not delivery failure or an unknown OS side effect. Suppress
      // new intent without filling the panel with one card per high-load sample.
      if (!store.read(notification.id)) {
        const decision = policy();
        if (!decision.allowed) return {delivered: false, error: decision.reason};
      }
      const saved = store.addNotification(notification, provenance);
      publish();
      if (saved.duplicate) {
        if (active.has(notification.id)) return active.get(notification.id).promise;
        if (saved.record.deliveryState === 'unknown' || saved.record.deliveryState === 'pending') {
          throw new Error('P5 notification delivery requires reconciliation');
        }
        return {delivered: saved.record.deliveryState === 'delivered'};
      }
      const notSent = error => {
        store.recordDelivery(notification.id, 'failed');
        publish();
        return error ? {delivered: false, error} : {delivered: false};
      };
      if (!authorized()) return notSent();
      const decision = policy();
      if (!decision.allowed) return notSent(decision.reason);
      let native;
      try {
        if (!Notification.isSupported()) return notSent();
        native = new Notification({title: notification.title, body: `${notification.message}\n${notification.advice}`});
      } catch { return notSent(); }
      let settled = false;
      let detached = false;
      let timer;
      let resolveResult, rejectResult;
      const promise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      const detach = () => {
        detached = true;
        clearTimeout(timer);
        native.removeListener('show', shown);
        native.removeListener('failed', failed);
        active.delete(notification.id);
      };
      const finish = delivered => {
        if (detached) return;
        if (!authorized()) { interrupt(); return; }
        const late = settled;
        try { store.recordDelivery(notification.id, delivered ? 'delivered' : 'failed'); }
        catch { unknown(); return; }
        detach();
        settled = true;
        publish();
        if (late) Promise.resolve().then(() => {
          if (authorized()) return onLateOutcome(notification.source, notification.id, delivered);
        }).catch(() => {});
        else resolveResult({delivered});
      };
      const shown = () => finish(true);
      const failed = () => finish(false);
      const unknown = (notify = true) => {
        if (detached) return;
        try { store.recordDelivery(notification.id, 'unknown'); } catch {}
        clearTimeout(timer);
        if (!settled) { settled = true; rejectResult(new Error('P5 notification delivery is unknown')); }
        if (notify) publish();
      };
      const interrupt = () => {
        unknown(false);
        detach();
        // Close only this host's notification; close does not prove non-delivery.
        try { native.close?.(); } catch {}
        publish();
      };
      timer = setTimeout(unknown, timeoutMs);
      native.once('show', shown);
      native.once('failed', failed);
      active.set(notification.id, {promise, stop: interrupt});
      if (!authorized()) {
        detach();
        const result = notSent();
        resolveResult(result);
        return promise;
      }
      const beforeShow = policy();
      if (!beforeShow.allowed) {
        detach();
        resolveResult(notSent(beforeShow.reason));
        return promise;
      }
      try { native.show(); } catch { unknown(); detach(); }
      return promise;
    },
    /** Host-only receipt readback, independent of a restarted sampling cache. */
    readDeliveryOutcome(id) {
      const record = store.read(id);
      if (!record) return undefined;
      if (!['pending', 'unknown', 'delivered', 'failed'].includes(record.deliveryState)) {
        throw new Error('Invalid P5 delivery readback');
      }
      return structuredClone({id: record.id, source: record.source, sourceTaskId: record.sourceTaskId,
        evidenceRefs: record.evidenceRefs, persisted: true, queued: record.deliveryState === 'pending',
        deliveryState: record.deliveryState, delivered: record.deliveryState === 'delivered',
        deliveredAt: record.deliveredAt, userRead: 'unobserved'});
    },
    readDeliveryPolicy: policy,
    // The trusted owner controls reactivation through isActive, not a second switch.
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
    },
  });
}
