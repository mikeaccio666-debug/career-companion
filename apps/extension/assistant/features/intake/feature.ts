import type { PrivateIntakePorts } from './private-ports';
/** Keep the visible scene and its transport under the same build admission. */
export function privateIntakeFeature(enabled: boolean, createPorts: () => PrivateIntakePorts) {
  return { ports: enabled ? { privateIntake: createPorts() } : {}, intakeEnabled: enabled };
}
