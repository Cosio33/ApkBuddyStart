# adb portátil

Extrae Android platform-tools en este directorio (debe aparecer `adb.exe`); ApkBuddyStart lo usará preferentemente:

```
tools/platform-tools/
└─ adb.exe
```

URL de descarga:https://developer.android.com/tools/releases/platform-tools

Si este directorio está vacío, ApkBuddyStart probará en este orden:

1. La ruta de adb indicada manualmente en la configuración
2. Este directorio
3. `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`
4. El adb incluido en emuladores habituales (LDPlayer / MuMu / BlueStacks)
5. El PATH del sistema
