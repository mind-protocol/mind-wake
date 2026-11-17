const fs = require('node:fs');
const path = require('node:path');
const {withMainApplication} = require('expo/config-plugins');

const keys = ['marco','vox','equerre','rose_des_vents','medicis'];
function kotlin(packageName) {
  return `package ${packageName}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.uimanager.ViewManager

class MindRingtoneCapabilitiesModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "MindRingtoneCapabilities"
  override fun getConstants(): MutableMap<String, Any> {
    val keys = listOf(${keys.map(k=>`"${k}"`).join(',')})
    val supported = keys.filter { key ->
      val id = context.resources.getIdentifier("ring_" + key, "raw", context.packageName)
      if (id == 0) false else try {
        context.resources.openRawResource(id).use { stream ->
          val header = ByteArray(12)
          stream.read(header) == 12 && String(header, 0, 4, Charsets.US_ASCII) == "RIFF" && String(header, 8, 4, Charsets.US_ASCII) == "WAVE"
        }
      } catch (_: Exception) { false }
    }
    return mutableMapOf("bundle" to "mind-ringtones-v1", "ringtoneKeys" to supported)
  }
}
class MindRingtoneCapabilitiesPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(MindRingtoneCapabilitiesModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
`;
}
function patchMain(contents) {
  if(contents.includes('add(MindRingtoneCapabilitiesPackage())')) return contents;
  const needle='PackageList(this).packages.apply {';
  if(contents.split(needle).length!==2) throw Error('Ringtone native proof: modèle MainApplication Kotlin inattendu; refus de deviner.');
  return contents.replace(needle,needle+'\n              add(MindRingtoneCapabilitiesPackage())');
}
module.exports = config => withMainApplication(config, mod => {
  if(mod.modResults.language!=='kt') throw Error('Ringtone native proof: MainApplication Kotlin requis.');
  const match=mod.modResults.contents.match(/^package\s+([A-Za-z_][A-Za-z0-9_.]*)/m);
  if(!match || !mod.modResults.path) throw Error('Ringtone native proof: package/chemin MainApplication absent.');
  mod.modResults.contents=patchMain(mod.modResults.contents);
  const target=path.join(path.dirname(mod.modResults.path),'MindRingtoneCapabilitiesModule.kt');
  fs.writeFileSync(target,kotlin(match[1]));
  return mod;
});
module.exports.patchMain=patchMain;
module.exports.kotlin=kotlin;
