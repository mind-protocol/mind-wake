import { elevenLabsCircuitStatus, enableElevenLabs, VOICE_CUT_MESSAGE } from "../../communication/elevenlabs-circuit.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";

/** `elevenlabs status|enable` : lecture locale et réactivation humaine, sans appel réseau. */
export function elevenlabs(dataDir: DataDir, action: string | undefined): CommandResult<unknown> {
  switch (action ?? "status") {
    case "status": {
      const state = elevenLabsCircuitStatus(dataDir.path);
      return {
        exitCode: 0,
        data: state,
        human: () =>
          state.circuit
            ? `${VOICE_CUT_MESSAGE}\nCoupée le ${state.circuit.at} : ${state.circuit.reason}.`
            : state.enabled
              ? "ElevenLabs activé."
              : "ElevenLabs désactivé.",
      };
    }
    case "enable": {
      const result = enableElevenLabs(dataDir.path);
      return {
        exitCode: 0,
        data: result,
        human: () =>
          result.circuitClosed
            ? "ElevenLabs réactivé ; disjoncteur fermé. Aucun appel de test n'a été fait."
            : "ElevenLabs réactivé. Aucun appel de test n'a été fait.",
      };
    }
    default:
      throw Error(`action ElevenLabs inconnue : ${action ?? ""}`);
  }
}
