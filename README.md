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
