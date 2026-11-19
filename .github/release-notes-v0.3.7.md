# ApkBuddyStart v0.3.7

> En una frase: se arregla **el botón de cerrar de la esquina superior derecha de la ventana de la aplicación** (cerrar debe terminar realmente la aplicación Android) y se pasa la **red de la máquina virtual** de «depender de la suerte» a «autosanación»; además, ya está configurado el token de CI para sincronizar Gitee.

## 1. Corrección: el botón de la esquina superior derecha; cerrar ahora termina realmente la aplicación

**Problema**: al pulsar la ⨯ de la barra de título, la ventana desaparece, pero la aplicación Android sigue ejecutándose en segundo plano; al volver a abrir esa aplicación parece como si no se hubiera cerrado nunca.

**Causa**: `shell:close` llamaba directamente a `win.close()` de Electron, saltándose la lógica de cierre de `AppWindow.close()`. El evento `closed` de la ventana solo limpiaba el estado interno: **no hacía `force-stop` de la aplicación Android ni separaba la ventana del emulador del anfitrión**. Lo mismo ocurría al cerrar con Alt+F4 o desde la barra de tareas.

**Corrección**:

- El botón ⨯ ahora pasa por `appWin.close()`: primero separa y oculta la ventana del emulador, y luego detiene la aplicación Android con `am force-stop`;
- El evento `closed` incorpora la misma lógica de cierre (cubre Alt+F4, cierre desde la barra de tareas, apagado del sistema, etc.);
- La lógica de rotación / minimizar / maximizar se mantiene igual, sin cambios.

**Prueba real**: tras enviar `WM_CLOSE` a la ventana de la aplicación, `pidof com.phoenix.read` pasa de `5152` a **vacío** y el primer plano vuelve al escritorio de Android: la aplicación realmente ha salido.

## 2. Red: se acabó depender de la suerte, ahora hay autosanación

La versión anterior ya había localizado que «Hongguo se queda en pantalla negra al pulsar aceptar» = la máquina virtual no tiene red. Pero entonces solo se trataba de «esperar un poco más», y en un arranque en el que el Wi-Fi no se asocia nunca seguía agotándose el tiempo de espera.

Esta versión cambia el tratamiento de la red por una **escalada automática de menor a mayor coste**:

1. **Esperar a la red antes de lanzar la aplicación** (máx. 60 s, con progreso visible en el registro);
2. Si no se consigue, **hacer un arranque en frío de la máquina virtual** (`-no-snapshot-load`, para evitar una instantánea de arranque rápido que se guardara mientras no había red) y esperar de nuevo hasta 180 s;
3. En cuanto la red funciona, **se guarda de inmediato una instantánea**, de modo que la próxima vez se restaure también el estado de la tarjeta de red;
4. «Ajustes → Reparar red» usa el mismo flujo y solo **restablece los datos de Android** si fallan los dos primeros pasos (se conserva la lista de aplicaciones y abrirlas las reinstala automáticamente, pero se pierden la sesión y los registros propios de las aplicaciones).

> Sobre «subir la versión de Android»: esta vez no se ha cambiado la imagen. El motivo es que cambiarla obligaría a todos los usuarios a volver a descargar 1,5 GB, y en las pruebas la raíz del problema está en **la asociación del Wi-Fi del emulador, que es lenta o a veces no se produce**, no en la versión de Android en sí; «esperar + autosanación con arranque en frío» cubre el mismo escenario sin aumentar el tamaño. Si más adelante se demuestra que la imagen de una versión determinada es más estable, se publicará una versión aparte para migrar.

## 3. CI: el token para sincronizar Gitee ya está configurado

El secreto de Actions `GITEE_TOKEN` del repositorio de GitHub ya está dado de alta. En adelante, al publicar con una etiqueta `v*`, el flujo de Release sincronizará automáticamente la versión portable a Gitee, sin necesidad de ejecutar el script a mano.

## 4. Pruebas reales

- `npm test`: **113 pruebas, todas superadas** (8 + 25 + 80).
- Tras cerrar la ventana, `pidof com.phoenix.read` está vacío (la aplicación realmente ha salido).
- Registro de red lista: `máquina virtual en red lista (10.0.2.16)`, y a continuación la portada de Hongguo se renderiza con normalidad.

## 5. Cómo actualizar

- Versión portable: descomprime y sobrescribe; el directorio de datos (por defecto `%APPDATA%\apkstart`) se mantiene igual.
- Versión instalada: instala directamente para sobrescribir.
