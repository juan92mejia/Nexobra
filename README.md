# Nexobra — proyecto real (backend + PWA)

Este es el código funcional de Nexobra, probado y listo para desplegar. Incluye:

- **Backend** en Node.js/Express con una base de datos real (archivo `db.json`, motor lowdb).
- **Nexobra Mercado**: comparador de cotizaciones + base de proveedores + botón de WhatsApp.
- **Nexobra Nextrics**: inteligencia financiera con múltiples proyectos guardados.
- **Extracción con IA**: usa tu propia llave de la API de Anthropic (no depende de que el usuario tenga cuenta de Claude).
- **PWA**: instalable en Android y iOS desde el navegador, sin pasar por App Store ni Google Play.

No necesitas saber programar para ponerlo en línea — sigue los pasos.

---

## 1. Probarlo en tu computador (opcional pero recomendado)

Necesitas tener [Node.js](https://nodejs.org) instalado (versión 18 o más reciente).

```
cd backend
npm install
npm start
```

Abre `http://localhost:3000` en tu navegador. Ya deberías ver Nexobra funcionando con datos reales guardados en `db.json`.

---

## 2. Ponerlo en internet gratis (recomendado: Render)

1. Crea una cuenta gratuita en [render.com](https://render.com).
2. Sube esta carpeta `backend` a un repositorio de GitHub (puedes crear una cuenta gratis en [github.com](https://github.com) si no tienes una, y subir la carpeta con "Upload files" desde el navegador, sin usar la terminal).
3. En Render, elige **New → Web Service**, conecta tu repositorio de GitHub.
4. Configuración:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. En la sección **Environment Variables**, agrega:
   - `ANTHROPIC_API_KEY` = tu llave (ver paso 3 abajo). Puedes dejarlo vacío por ahora si todavía no quieres activar la extracción con IA — el resto de la app funciona igual.
   - `MONGODB_URI` = **muy importante**, ver la sección 10 más abajo ("Guardado permanente de datos"). Sin esta variable, el plan gratuito de Render borra todos los datos (cotizaciones, acuerdos, pedidos, etc.) cada vez que el servidor se duerme por inactividad.
6. Haz clic en **Deploy**. En unos minutos tendrás una URL pública como `https://nexobra.onrender.com`.

**Alternativas equivalentes** si prefieres: [Railway.app](https://railway.app) o [Fly.io](https://fly.io) — el proceso es muy similar.

> Nota sobre el plan gratuito de Render: el servidor "se duerme" tras 15 minutos sin uso y tarda unos segundos en despertar con la primera visita. Para un piloto está perfecto; si más adelante tienes clientes pagando, un plan pago (~$7 USD/mes) lo mantiene siempre activo.

---

## 3. Activar la extracción de cotizaciones con IA

1. Crea una cuenta en [console.anthropic.com](https://console.anthropic.com) (es la plataforma de desarrolladores, distinta de tu cuenta normal de Claude).
2. Genera una API key.
3. Agrégala como variable de entorno `ANTHROPIC_API_KEY` en Render (o en tu archivo `.env` local, copiando `.env.example`).
4. El uso de la API tiene costo por uso (muy bajo para extraer texto — céntimos de dólar por cotización). Revisa los precios vigentes en la consola antes de activarlo con muchos usuarios.

Sin esta llave configurada, el resto de la app (comparador, proveedores, Nextrics) funciona exactamente igual — solo el botón "Extraer con IA" mostrará un mensaje explicando que falta configurarlo.

---

## 4. Conectar tu dominio propio

Cuando registres `nexobra.co` (o el que elijas):

1. En Render, ve a tu servicio → **Settings → Custom Domain**.
2. Agrega tu dominio y sigue las instrucciones para apuntar los DNS desde donde compraste el dominio.
3. Render genera el certificado SSL (candado de seguridad) automáticamente y gratis.

---

## 5. Instalar como app en el celular (PWA — ya funciona, sin costo adicional)

Con la app ya en línea (Render o tu dominio):

- **Android (Chrome):** abre la URL → menú (⋮) → "Instalar app" o "Agregar a pantalla de inicio".
- **iOS (Safari):** abre la URL → botón compartir → "Agregar a pantalla de inicio".

Queda como un ícono normal en el celular, abre en pantalla completa, y funciona sin conexión para las pantallas ya visitadas (los datos siempre se sincronizan con tu servidor cuando hay internet).

**Nota sobre los íconos:** generé un ícono de marca (la "N" bicolor carbón/naranja, inspirada en tu brandbook) en `public/icons/`. Si más adelante tienes el archivo vectorial final de tu diseñador, reemplaza esos dos archivos por tu logo real (mismo nombre, mismo tamaño: 192x192 y 512x512 píxeles).

---

## 6. Cuándo pasar a una app nativa real (App Store / Google Play)

Este proyecto ya es una API real — el mismo backend puede alimentar una app nativa hecha con React Native o Flutter más adelante, sin rehacer la lógica de negocio. Ese es el momento de considerarlo: cuando tengas usuarios pagando y necesites notificaciones push, cámara nativa, o presencia en las tiendas de aplicaciones.

---

## 7. Novedades de Nexobra Mercado (comparador de cotizaciones avanzado)

`mercado.html` y `server.js` ahora incluyen un comparador de cotizaciones mucho más completo, pensado según la forma en que trabajan las áreas de compras profesionales (costo total, no solo precio) y ajustado a la normativa tributaria colombiana:

- **Comparación real (TCO), no solo precio**: cada cotización calcula precio + IVA + transporte + costo financiero del anticipo (si se configura un costo de capital anual) + retenciones, para mostrar el costo total real de comprarle a cada proveedor.
- **Retenciones colombianas automáticas**: retención en la fuente (2.5%/3.5% según si el proveedor es declarante, con la base mínima legal de 10 UVT), ReteICA (con un botón "Sugerir con IA" que da una referencia — nunca reemplaza confirmar la tarifa exacta con la Secretaría de Hacienda del municipio, porque varía por actividad económica y cambia con el tiempo) y retención de garantía técnica (explicada en lenguaje sencillo, con opciones típicas de 5-10% y plazos de liberación de 30/60/90/180 días).
- **Plan de compra recomendado**: por cada material, sugiere el mejor proveedor considerando precio, disponibilidad de stock y confiabilidad histórica (% de pedidos a tiempo y calidad reportada), y avisa cuándo conviene dividir la compra entre dos proveedores (mostrando siempre el ahorro real y las desventajas de tener dos entregas en vez de una). También compara "un solo proveedor que cubra todo el pedido" contra "combinar por mejor precio", y solo recomienda combinar si el ahorro supera el umbral que configures (ajustable en "Ajustes de comparación" — por defecto 8%); si no lo supera, recomienda quedarse con el proveedor que resuelve todo en un solo pedido, aunque no sea el más barato ítem por ítem.
- **Unificar materiales equivalentes**: cada proveedor nombra sus productos distinto (p. ej. "Válvula 2\" HD" vs "Válvula BR 2\" APOLO"), así que la app detecta automáticamente posibles coincidencias por nombre y pregunta si son el mismo material — nunca los une sola. Solo así puede saber si un proveedor realmente cubre tu pedido completo o si un pedido es solo un producto de varios que necesitas.
- **Alertas de riesgo de compras**: aviso si un solo proveedor concentra la mayoría del gasto (riesgo de dependencia) y aviso si hay compras fragmentadas del mismo material que convendría consolidar en un solo pedido.
- **Presupuesto de obra y compra anticipada**: se registran las cantidades totales presupuestadas por material; la app sugiere cotizar y negociar anticipadamente el 60% de esas cantidades (porcentaje configurable) y avisa cuándo reabastecer al llegar al 15% restante (también configurable), para evitar pedidos de última hora y demoras en obra.
- **Importar presupuesto desde Excel o PDF**: se puede adjuntar el archivo de presupuesto (con muchos ítems divididos en actividades o módulos) y la app reconoce el contenido automáticamente — con IA para los casos más difíciles de interpretar — mostrando siempre una vista previa editable antes de guardar nada (nunca se importa sin revisión humana). Los PDF escaneados como imagen no se pueden leer automáticamente (no hay OCR); en ese caso, la alternativa es adjuntar el archivo directamente en una conversación de Claude para pedir ayuda a convertirlo primero.
- **Búsqueda ampliada de materiales y fabricantes**: enlaces de búsqueda rápida en mercados más grandes y sugerencias de fabricantes/distribuidores directos (con IA, siempre como referencia a confirmar) para materiales difíciles de cotizar localmente o que requieren pedido por encargo, buscando evitar intermediarios.

Todas las sugerencias generadas con IA (fabricantes, ReteICA, extracción de presupuestos) se muestran siempre como una ayuda de referencia, nunca se guardan automáticamente sin que la persona las revise y confirme.

---

## 8. Novedades adicionales — inspiradas en plataformas de e-procurement como IConstruye

Después de investigar cómo funcionan plataformas grandes de compras para constructoras (IConstruye, presente en Colombia/Chile/México), se adaptaron sus mejores funciones a una versión ligera y económica, y se agregaron ideas que esas plataformas no tienen:

- **Obras/proyectos**: opcional. Si manejas varias obras al tiempo, créalas en "Obras / proyectos" y selecciona la "obra activa" — así el presupuesto y las cotizaciones de cada obra no se mezclan. Si no creas ninguna, todo sigue junto como "General", igual que antes.
- **Datos de tu empresa**: razón social, NIT y dirección (en "Ajustes de comparación"), usados para membretar tus órdenes de compra.
- **Proveedores enriquecidos**: ahora puedes guardar el NIT, categoría y dirección de cada proveedor (en "Desempeño y gasto por proveedor"), y ver su % de participación sobre tu gasto total — igual que el "monitor de participación de proveedores" de las plataformas grandes.
- **Orden de compra formal**: botón "Generar orden de compra" en cada cotización — abre un documento limpio y membretado (tu empresa + el proveedor + los ítems + totales) listo para imprimir o guardar como PDF, sin depender de ninguna plataforma externa.
- **Acuerdos marco (compra contra convenios)**: si ya negociaste un precio fijo con un proveedor por un tiempo determinado, regístralo. El comparador lo usa para avisarte si una cotización nueva viene por encima de lo pactado (para que reclames el precio acordado) y te avisa cuándo el acuerdo está por vencer, para que renegocies a tiempo — esta alerta de vencimiento no la vimos en la competencia revisada.

**Lo que decidimos NO copiar de las plataformas grandes, y por qué**: gestión de bodega/inventario, facturación electrónica integrada con la DIAN, flujos de aprobación multiusuario y un "monitor" de miles de proyectos de terceros. Son funciones que requieren infraestructura mucho más pesada (sistema de usuarios y roles, integraciones oficiales, una red de datos que no existe todavía) — construirlas a medias daría una falsa sensación de robustez. El diferencial de Nexobra frente a esas plataformas sigue siendo ser simple, económico y hecho a la medida del cumplimiento tributario y el tamaño de la pyme constructora colombiana.

---

## 9. Editar cotizaciones, pedidos parciales, reconocimiento por marca y grupos empresariales

- **Editar cotización**: cada cotización tiene un botón "Editar cotización" que recarga sus datos en el formulario (datos básicos, pago y condiciones, garantía técnica y los materiales cotizados) para corregirla o agregar/quitar ítems, en vez de tener que borrarla y crearla de nuevo.
- **Pedir solo una parte de una cotización**: cada material de una cotización tiene una casilla de selección. Si al final no vas a comprar el pedido completo, desmarca lo que no vas a pedir — el total se recalcula solo con lo marcado, y así se genera la orden de compra, el mensaje de WhatsApp y el "pedido" correspondiente. La cotización original nunca se modifica: queda intacta como referencia de lo que te cotizaron.
- **Reconocimiento de materiales sin importar la marca**: la detección de "¿son el mismo material?" ahora ignora marcas/fabricantes conocidos (Pavco Wavin, Tubosa Coex, Apolo, Celco, Gerfor, Argos, Cemex, etc.) y diferencias de formato de unidades ("6m" vs "6 m"), para reconocer que, por ejemplo, "Tubo sanitario 2\" x 6 m Pavco Wavin" y "Tubo sanitario 2\" x 6m Tubosa Coex" son el mismo tubo con distinta marca — siempre pidiendo tu confirmación antes de unificarlos, igual que antes.
- **Grupos empresariales y varias empresas/NIT**: si varias empresas del mismo grupo cotizan por separado (cada una a su propio NIT) pero comparten proveedores, ahora puedes crear un login de "grupo empresarial" (usuario y contraseña) y, dentro de esa sesión, dar de alta cada empresa del grupo con su razón social, NIT y dirección. Cada empresa segmenta sus propias obras, cotizaciones y presupuesto, pero **todas comparten el mismo listado de proveedores** de la aplicación. Las órdenes de compra usan automáticamente los datos de la empresa activa. Si más adelante necesitas vincular otro grupo empresarial totalmente ajeno (con su propia contraseña, sin compartir empresas ni obras — solo el listado de proveedores), puedes crearlo desde la pantalla de inicio de sesión ("Vincular otro grupo empresarial"). Mientras no crees ningún grupo, la app sigue funcionando sin pedir login, como antes.

---

## 10. Guardado permanente de datos (MongoDB Atlas, gratis) — instrucciones importantes

**¿Qué pasaba?** El plan gratuito de Render "duerme" el servidor tras 15 minutos sin uso, y cada vez que despierta (o cada vez que subes una actualización), **borra el disco donde se guardaba el archivo de datos**. Por eso, después de cerrar sesión y volver a entrar, las cotizaciones y acuerdos marco desaparecían — no era una falla del login ni de ninguna función nueva, sino una limitación del almacenamiento gratuito de Render que ya existía desde el principio y se volvió visible al usar la app día a día.

**La solución**: guardar los datos en una base de datos externa gratuita (MongoDB Atlas) en vez del disco de Render. Es gratis para este tamaño de app (hasta 512 MB, muchísimo más de lo que Nexobra necesita) y no cambia nada de cómo usas la aplicación.

### Cómo activarlo (una sola vez, no requiere saber programar)

1. Entra a [mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register) y crea una cuenta gratis (puedes usar tu cuenta de Google).
2. Cuando te pida crear tu primer clúster ("Deploy your database"), elige la opción **M0 Free** (gratis) y déjalo con la región más cercana sugerida por defecto. Dale un nombre si quieres (ej. `nexobra`) y crea el clúster — tarda 1-3 minutos.
3. Te pedirá crear un usuario de base de datos: pon un usuario y una contraseña (guárdalos, los necesitas en el paso 6). Evita caracteres raros como `@` o `/` en la contraseña para que no den problemas más adelante.
4. En "Where would you like to connect from" (o en **Network Access** si no te aparece), agrega la opción **Allow access from anywhere** (`0.0.0.0/0`) — es necesario porque Render se conecta desde direcciones que cambian.
5. Ve a tu clúster → botón **Connect** → **Drivers** (o "Connect your application") → elige **Node.js**. Te va a mostrar un texto parecido a:
   `mongodb+srv://tuUsuario:<password>@nexobra.xxxxx.mongodb.net/?retryWrites=true&w=majority`
6. Copia ese texto y reemplaza `<password>` por la contraseña real que creaste en el paso 3.
7. En Render, ve a tu servicio → **Environment** → agrega una variable nueva:
   - Nombre: `MONGODB_URI`
   - Valor: el texto completo del paso 6.
8. Guarda — Render vuelve a desplegar el servicio automáticamente. Desde ese momento, todo lo que guardes en Nexobra (cotizaciones, acuerdos, pedidos, presupuesto, historial, empresas) queda en MongoDB de forma permanente, sin importar cuántas veces se duerma o se reinicie el servidor.

**Importante:** los datos de prueba que hayas creado ANTES de configurar `MONGODB_URI` no se trasladan automáticamente (la app empieza "en blanco" la primera vez que usa MongoDB). Todo lo que registres después de este paso sí queda guardado para siempre.

Si nunca configuras `MONGODB_URI`, la app sigue funcionando exactamente igual que antes (usando el archivo local), con la misma limitación de que Render puede borrarlo — así que se recomienda hacer esta configuración cuanto antes.

---

## 11. Historial de acciones (nuevo)

Se agregó una tarjeta **"Historial de acciones"** (visible en el menú superior) que registra automáticamente cada cotización, edición, pedido, acuerdo marco, obra o empresa que se crea, edita, completa o elimina, con fecha y hora exacta — para poder consultar en cualquier momento qué pasó y cuándo, incluso mucho tiempo después, y así también verificar que las cotizaciones nuevas quedaron bien registradas.

- **Consultar**: la tabla se actualiza sola al entrar y con el botón "Actualizar". Muestra fecha/hora, qué acción fue, sobre qué tipo de registro, y el detalle.
- **Descargar el archivo**: el botón "Descargar historial (.csv)" genera un archivo `.csv` con todo el historial, que se abre directamente en Excel — así puedes guardarlo, imprimirlo o revisarlo fuera de la aplicación cuando quieras.
- **Borrar historial**: el botón "Borrar historial" (en rojo) pide confirmación y borra el registro de acciones. Esto **no borra tus cotizaciones, pedidos ni acuerdos** — solo limpia la bitácora de qué pasó y cuándo, por si quieres empezar un historial nuevo.
- Si usas grupos empresariales, cada grupo ve y borra únicamente su propio historial.

---

## Estructura del proyecto

```
backend/
  server.js          → toda la lógica de negocio (API)
  db.json            → base de datos (se crea sola al arrancar)
  public/
    index.html       → página principal
    mercado.html      → Nexobra Mercado
    nextrics.html      → Nexobra Nextrics
    manifest.json     → configuración de la PWA
    sw.js             → service worker (funcionamiento offline básico)
    icons/            → íconos de la app (reemplázalos por tu logo)
```
