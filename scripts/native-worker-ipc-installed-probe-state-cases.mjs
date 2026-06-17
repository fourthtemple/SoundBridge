import {
  nativeStateFileText,
  summarizeNativeStateProfile
} from "./installed-plugin-probe-file-grants.mjs";

export function exerciseInstalledProbeStateSupport({ check }) {
  const vst3ProbeState = nativeStateEnvelope({
    format: "vst3",
    component: "Y29tcG9uZW50",
    controller: "Y29udHJvbGxlcg=="
  });
  const vst3ComponentOnlyState = nativeStateEnvelope({
    format: "vst3",
    component: "Yw=="
  });
  const vst3ControllerOnlyState = nativeStateEnvelope({
    format: "vst3",
    controller: "Yw=="
  });
  const vst3EmptyState = nativeStateEnvelope({ format: "vst3" });
  const vst3StateProfile = summarizeNativeStateProfile("vst3", vst3ProbeState);
  const vst3ComponentOnlyProfile = summarizeNativeStateProfile("vst3", vst3ComponentOnlyState);
  const vst3ControllerOnlyProfile = summarizeNativeStateProfile("vst3", vst3ControllerOnlyState);
  const vst3EmptyProfile = summarizeNativeStateProfile("vst3", vst3EmptyState);
  const lv2ProbeState = nativeStateEnvelope({ format: "lv2", state: "bHYyLXN0YXRl" });
  const lv2StateProfile = summarizeNativeStateProfile("lv2", lv2ProbeState);
  const invalidComponentProfile = summarizeNativeStateProfile("vst3", nativeStateEnvelope({ format: "vst3", component: "bad" }));
  const invalidControllerProfile = summarizeNativeStateProfile("vst3", nativeStateEnvelope({ format: "vst3", controller: "bad" }));
  const formatMismatchProfile = summarizeNativeStateProfile("vst3", lv2ProbeState);

  check(
    nativeStateFileText("vst3", vst3ProbeState) === "Y29tcG9uZW50 Y29udHJvbGxlcg==\n" &&
      nativeStateFileText("vst3", vst3ComponentOnlyState) === "Yw== -\n" &&
      nativeStateFileText("vst3", vst3ControllerOnlyState) === "- Yw==\n" &&
      nativeStateFileText("vst3", vst3EmptyState) === "" &&
      nativeStateFileText("lv2", lv2ProbeState) === "bHYyLXN0YXRl\n" &&
      nativeStateFileText("au", lv2ProbeState) === "",
    "installed plugin probe exports bounded native state files"
  );
  check(
    vst3StateProfile.category === "component-controller" &&
      vst3StateProfile.stateBytes === 19 &&
      vst3StateProfile.componentBytes === 9 &&
      vst3StateProfile.controllerBytes === 10 &&
      vst3ComponentOnlyProfile.category === "component-only" &&
      vst3ComponentOnlyProfile.flags.includes("component") &&
      vst3ComponentOnlyProfile.stateBytes === 1 &&
      vst3ControllerOnlyProfile.category === "controller-only" &&
      vst3ControllerOnlyProfile.flags.includes("controller") &&
      vst3ControllerOnlyProfile.stateBytes === 1 &&
      vst3EmptyProfile.category === "empty" &&
      vst3EmptyProfile.flags.includes("empty-state") &&
      lv2StateProfile.category === "single-state" &&
      lv2StateProfile.stateBytes === 9 &&
      invalidComponentProfile.category === "invalid" &&
      invalidComponentProfile.flags.includes("invalid-component-base64") &&
      invalidControllerProfile.category === "invalid" &&
      invalidControllerProfile.flags.includes("invalid-controller-base64") &&
      formatMismatchProfile.category === "format-mismatch" &&
      summarizeNativeStateProfile("vst3", Buffer.from("{}", "utf8").toString("base64")).category === "generic-state" &&
      summarizeNativeStateProfile("vst3", "not-state").category === "invalid",
    "installed plugin probe classifies bounded native state profiles"
  );
}

function nativeStateEnvelope(nativeState) {
  return Buffer.from(JSON.stringify({ nativeState }), "utf8").toString("base64");
}
