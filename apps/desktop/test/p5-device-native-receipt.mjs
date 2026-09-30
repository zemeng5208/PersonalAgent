import {createP5DeviceNotificationHost} from '../electron/p5-device-notification-host.js';
import {createP5DeviceReceiptStore} from '../electron/p5-device-receipt-store.js';

/** P8 calls this once with actual Electron Notification and an isolated Runtime namespace port. */
export async function captureP5SyntheticNativeReceipt({Notification, storage, readDeliveryPolicy,
  caseId, allowOneSyntheticNotification = false} = {}) {
  if (allowOneSyntheticNotification !== true) return {state: 'not_started', delivered: false};
  if (typeof caseId !== 'string' || !/^p5-native-case-[a-z0-9-]{1,64}$/.test(caseId)
    || !storage || typeof readDeliveryPolicy !== 'function') throw new Error('Invalid P5 native receipt case');
  const store = createP5DeviceReceiptStore({storage, allowedSources: ['injected']});
  const existing = store.read(caseId);
  const notification = {id: caseId, source: 'injected',
    timestamp: existing?.timestamp ?? new Date().toISOString(),
    title: 'PersonalAgent 通知验收（合成输入）',
    message: '这是一次公开合成资源提醒，不表示当前电脑出现高负载。',
    advice: '仅核实系统通知回执；不会停止应用或修改系统设置。',
    candidateId: 'synthetic-notification-case'};
  const provenance = {taskId: 'synthetic-device-input', source: notification.source,
    timestamp: notification.timestamp, evidenceRefs: ['synthetic-input-not-runtime-evidence']};
  const host = createP5DeviceNotificationHost({Notification, store, readDeliveryPolicy,
    readProvenance: () => provenance, isActive: () => true});
  let result, error;
  try { result = await host.sendAdvisoryNotification(notification); }
  catch { error = 'delivery_unknown_or_reconciliation_required'; }
  finally { host.dispose(); }
  const receipt = host.readDeliveryOutcome(caseId);
  return {
    caseId, capturedAt: new Date().toISOString(),
    inputKind: 'public_synthetic_advisory', observationKind: 'electron_notification_receipt',
    realMetricsTriggered: false, layaChoiceVerified: false, runtimeToolEvidenceVerified: false,
    priorRecordPresent: Boolean(existing),
    state: receipt?.deliveryState ?? 'suppressed',
    delivered: receipt?.deliveryState === 'delivered',
    persisted: Boolean(receipt), userRead: 'unobserved',
    ...(result?.error ? {reason: result.error} : {}), ...(error ? {error} : {}),
    ...(receipt ? {receipt} : {}),
  };
}
