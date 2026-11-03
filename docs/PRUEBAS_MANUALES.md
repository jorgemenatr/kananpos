# Pruebas manuales con el lector real

Hazlas en la laptop y con el lector que se van a usar el día del escaneo, sobre la URL de
Netlify. Ten abierto el **Table Editor** de Supabase (`products` e `inventory_movements`) para
confirmar los datos.

> Tip: usa 3 o 4 productos de prueba y, al terminar, bórralos desde el dashboard: primero
> sus filas en `inventory_movements` y luego en `products`.

## Sin lector: simulador

Mientras no tengas el lector, abre la app con **`?simulador=1`** al final de la URL (por
ejemplo `https://<tu-sitio>/?simulador=1`). Aparece un panel morado abajo a la izquierda.
Igual que un lector USB, el simulador escribe el código muy rápido en el campo que tenga
el foco y luego manda Enter. Sus botones no le quitan el foco a ese campo.

- **Código nuevo**: un EAN-13 aleatorio que no existe, para probar el alta.
- **Productos existentes**: los últimos productos del catálogo, para probar escaneo repetido.
- **Lector con teclado de EE. UU.**: manda `HCH'000001` (con apóstrofo), como llegaría con un
  lector en distribución US.
- **Código personalizado**: para escribir el que quieras (p. ej. el de un producto real).

Para apagarlo, abre la app con `?simulador=0`. Con el simulador puedes hacer todas las
pruebas de abajo excepto la **0**, que necesita el lector físico. Hazla en cuanto lo tengas.

Otra opción, aún más realista: una app de celular que mande el código a la laptop como si
fuera un teclado (p. ej. *Barcode to PC*, gratis en Android e iOS, con su programa para la
laptop). Así escaneas los códigos reales de los productos con la cámara del celular.

## 0. Lector y teclado
- [ ] En la pantalla de escaneo, escanea un producto cualquiera. El código completo aparece
      y se procesa solo (el lector manda Enter).
- [ ] Tras crear un producto sin código (prueba 6), imprime su etiqueta y escanéala. Debe
      encontrar el producto `HCH-000001` (con guion, aunque el lector mande `'`).

## 1. Login y logout
- [ ] Con contraseña incorrecta aparece "Correo o contraseña incorrectos." y el foco queda
      en la contraseña.
- [ ] Con la laptop sin internet, intenta iniciar sesión: aparece "Sin conexión a internet…".
- [ ] Login correcto: llegas al Mostrador. En Inventario → Conteo y ajustes, el cursor ya
      está en el campo de escaneo (puedes escanear sin hacer clic).
- [ ] El encabezado muestra tu correo y el botón "Cerrar sesión".
- [ ] Cierra la pestaña y vuelve a abrir la URL: sigues dentro sin volver a iniciar sesión.
- [ ] "Cerrar sesión" te lleva al login con el cursor en la contraseña (el correo queda recordado).

## 2. Acceso sin sesión
- [ ] Sin sesión, abre `https://<tu-sitio>/historial`: te manda al login. Al iniciar sesión,
      regresa a Historial.
- [ ] Desde una ventana de incógnito, abre `https://<tu-proyecto>.supabase.co/rest/v1/products`
      con la anon key (o desde la consola del navegador sin sesión). Debe responder
      `permission denied`.

## 3. Escaneo repetido
- [ ] Con cantidad 1 y modo **Sumar**, escanea el mismo producto 5 veces seguidas, rápido.
      La cantidad sube de 1 en 1. Cada escaneo hace un "bip" y pinta el panel de verde.
- [ ] En Supabase, la cantidad coincide y hay 5 movimientos `scan_add`.
- [ ] Cambia la cantidad a 24, presiona Enter (el cursor vuelve al escaneo) y escanea: +24.
- [ ] Haz clic en "Cantidad" y, sin escribir nada, escanea un producto. Debe procesarse
      como escaneo y la cantidad debe seguir igual.
- [ ] Haz clic en cualquier parte vacía de la pantalla: el cursor regresa al escaneo.
- [ ] Los contadores "Productos distintos" y "Piezas totales" se actualizan.

## 4. Código nuevo
- [ ] Escanea un código que no exista: suena un tono doble y se abre el formulario con el
      código ya puesto y el cursor en "Nombre".
- [ ] Intenta guardar sin precio: aparece el error y no se guarda.
- [ ] Llena nombre y precio (prueba con coma: `45,50`), sube una foto desde archivo y
      presiona **Enter**. Se guarda, el panel azul muestra la foto y el cursor vuelve al escaneo.
- [ ] Con el formulario abierto, escanea otro producto por accidente: aparece el aviso
      "Se detectó un escaneo…" y el código **no** queda en el nombre.
- [ ] Prueba "Usar cámara": el navegador pide permiso, ves la imagen y "Tomar foto" la adjunta.
- [ ] La cantidad inicial por defecto es la "Cantidad por escaneo" actual.

## 5. Modo Fijar total
- [ ] Cambia a **Fijar total** (el aviso naranja indica el valor) y pon 10. Escanea un
      producto que tenga más de 10: queda en 10 y el panel muestra el delta negativo.
- [ ] En Supabase hay un movimiento `set_total` con el delta correcto.
- [ ] Regresa a **Sumar** antes de seguir.

## 6. Producto sin código
- [ ] "Producto sin código": el formulario dice que se generará el código. Guarda, y se
      asigna `HCH-000001` (o el siguiente número).
- [ ] "Imprimir etiqueta" abre la etiqueta con el nombre, el código de barras y el precio.
      Imprímela en la impresora real y ajusta la escala si hace falta.
- [ ] Escanea la etiqueta impresa: suma 1 a ese producto.

## 7. Deshacer
- [ ] Escanea un producto y presiona "Deshacer último escaneo": la cantidad regresa, el
      panel se pinta morado y en el panel lateral el escaneo aparece tachado.
- [ ] En Supabase hay un movimiento `adjustment` con el delta opuesto.
- [ ] Deshacer un "Fijar total" regresa a la cantidad que había antes.
- [ ] Deshacer un alta deja ese producto en 0 (el producto no se borra).

## 8. Historial y exportar
- [ ] Historial muestra los movimientos con tu nombre o correo y se puede buscar por
      código o nombre.
- [ ] "Exportar Excel": ábrelo en Excel. Los códigos se ven completos (sin `7.5E+12`), los
      acentos y las ñ se ven bien, y la URL de la imagen abre la foto.
- [ ] "Exportar CSV": ábrelo en un editor (o impórtalo). Los acentos están bien y tiene las
      columnas código, nombre, categoría, proveedor, costo, precio, cantidad, URL de imagen
      y fecha de alta.
- [ ] En Historial, exporta los movimientos (CSV y Excel) y revisa la columna "Usuario".

## 9. Desconectar internet y reconectar
- [ ] Apaga el Wi-Fi. El encabezado se pone rojo: "Sin conexión: 0 pendientes".
- [ ] Escanea 3 veces un producto conocido: el panel se pinta amarillo, dice "pendiente" y
      el contador queda en "Sin conexión: 3 pendientes".
- [ ] Escanea un código nuevo: el formulario avisa que se guardará sin conexión. Guárdalo
      (la imagen no se guarda sin red).
- [ ] "Producto sin código" y "Exportar" están deshabilitados.
- [ ] Deshacer el último escaneo lo quita de la cola (baja el número de pendientes).
- [ ] Presiona "Cerrar sesión": pide confirmación por los pendientes. Cancela.
- [ ] Recarga la página (F5) sin internet: los pendientes siguen ahí.
- [ ] Prende el Wi-Fi. En unos segundos el encabezado vuelve a verde ("En línea"), y en
      Supabase aparecen los movimientos **una sola vez** y el producto nuevo.
- [ ] Prueba larga (opcional): deja la laptop sin red más de 1 hora con pendientes y luego
      reconecta. Debe sincronizar o, si pide login, sincronizar después de iniciar sesión.

## 10. Catálogo TCG
Antes: aplica la migración `20261012000500_catalogo_tcg.sql` y corre la importación
(README → Catálogo TCG).
- [ ] Escanea un producto nuevo que no esté en el inventario: el formulario abre con el
      cursor en **Buscar en el catálogo TCG** y arriba dice cuántos productos tiene el
      catálogo y la fecha de actualización.
- [ ] Escribe `etb` y parte del nombre del set (p. ej. `delta etb`). Salen resultados con foto.
      Muévete con las flechas y presiona Enter: se llenan Nombre, Categoría (el juego),
      Descripción y la foto, y el cursor pasa a **Precio de venta**.
- [ ] Captura el precio y presiona Enter: el producto se da de alta con la foto del catálogo.
      En Supabase, `products.catalog_product_id` tiene el número de TCGplayer.
- [ ] Vuelve a escanear el mismo código: ya no abre el formulario, solo suma.
- [ ] Escanea un código nuevo, vincula un producto, presiona **Cambiar**: la foto del
      catálogo desaparece y puedes buscar otro.
- [ ] Sube una foto propia y luego vincula un producto: se queda tu foto, no la del catálogo.
- [ ] Busca un producto que ya vinculaste con otro código: el resultado avisa "Ya está en
      inventario con el código …".
- [ ] Si tienes producto de Magic o Yu-Gi-Oh! en inglés, escanéalo: si su código está en
      el catálogo, el formulario abre ya vinculado ("Encontrado en el catálogo por código de
      barras").
- [ ] Accesorios: busca `micas negras mate dragon`, `tapete pikachu` y
      `carpeta charizard 9 bolsillos`. Salen productos de Dragon Shield y Ultra Pro, y al
      elegirlos la categoría queda como la marca.
- [ ] Escanea unas micas Dragon Shield (p. ej. Classic negras de 100): si su código está en
      el catálogo, se vinculan solas.
- [ ] Sin internet, el formulario dice que el catálogo necesita conexión y deja capturar a mano.

## 11. Mostrador y ventas
Antes: aplica las migraciones `…000200_clientes.sql` y `…000300_ventas.sql`. Usa 2 o 3
productos de prueba con poco stock (p. ej. 3 piezas).
- [ ] Al iniciar sesión llegas al Mostrador. "Nuevo ticket" abre un ticket sin pedir nombre y
      el cursor queda en "Agregar producto".
- [ ] Escanea un producto: se agrega con bip. Escanéalo de nuevo: sube la cantidad.
- [ ] Sube la cantidad hasta el stock: el botón + se deshabilita y escanear otra vez avisa
      "No hay más stock".
- [ ] Abre otro ticket e intenta agregar el mismo producto: avisa que está apartado en otros
      tickets. En la lista, los dos dicen "Sin cliente" con su hora, piezas y total.
- [ ] Busca un producto escribiendo parte del nombre y agrégalo con Enter.
- [ ] Asigna un cliente existente (en la lista, el ticket ahora muestra su nombre); luego
      quítalo y da de alta uno nuevo desde el ticket.
- [ ] Recarga la página (F5): los tickets abiertos siguen ahí.
- [ ] En el primer ticket elige Efectivo, escribe lo recibido: muestra el cambio. Si es menos que el
      total, dice "Falta" y no deja pagar.
- [ ] Paga: aparece "Venta registrada · Ticket N" con el cambio. En Supabase hay un ticket
      nuevo con su folio, el stock bajó y en Historial hay movimientos "Venta: Ticket N".
      El siguiente cobro recibe el folio siguiente (N + 1).
- [ ] Apaga el Wi-Fi: se puede abrir un ticket y agregar productos, pero Cobrar está
      desactivado ("Sin conexión: cobra cuando vuelva el internet").
- [ ] Prende el Wi-Fi y cobra ese ticket: se registra con su folio, una sola vez.
- [ ] En Ventas, filtra por forma de pago y por fechas; haz clic en una venta para ver sus
      productos.
- [ ] En Clientes, abre el cliente del ticket cobrado: aparece en "Compras previas".

## 12. Créditos y pagos con varios métodos
Antes: aplica la migración `…000400_creditos.sql`.
- [ ] En Clientes, "Agregar créditos": sin concepto avisa. Pon "Premio torneo", agrega dos
      clientes con montos distintos y guarda. Aparece el aviso y la columna Créditos se llena.
- [ ] Un cliente ya elegido no se ofrece otra vez en el siguiente renglón.
- [ ] En el perfil de un cliente, "Agregar crédito" con otro concepto. Se actualizan
      Disponible y Ganados, y el historial muestra los dos movimientos con quién los registró.
- [ ] En el Mostrador, un ticket sin cliente: al elegir "Créditos" avisa que falta el cliente.
- [ ] Asigna al cliente con créditos y un producto que cueste más que su saldo. Con solo
      "Créditos" avisa que no alcanza. Elige también "Efectivo": créditos queda en su saldo y
      efectivo en el resto ("Cubierto").
- [ ] Cambia el monto de efectivo: créditos se ajusta solo. Si pasa del saldo, avisa;
      "Usar todo el saldo posible" lo corrige.
- [ ] Paga con efectivo recibido: muestra el cambio. El aviso dice "con créditos $… + efectivo $…".
- [ ] En el perfil, Disponible bajó y el historial muestra "Compra" con el monto en rojo.
- [ ] En Ventas, esa venta dice "Mixto"; al abrirla se ve el desglose por método. Los totales
      de arriba suman cada método por separado y el filtro "Mixto" la encuentra.
- [ ] Paga otro ticket con tres métodos (p. ej. tarjeta + transferencia + efectivo).
- [ ] Sin internet, "Créditos" avisa que necesita conexión; efectivo y tarjeta sí se cobran.

## 13. Tienda, bodega y lotes
Antes: aplica la migración `…20261019000100_lotes_ubicaciones.sql`.
- [ ] En Inventario, Total / Tienda / Bodega: al principio Bodega está en 0 en todo y Tienda
      igual que antes. En "Editar producto" cada producto con piezas tiene un lote
      "Inventario inicial" en tienda con su costo.
- [ ] Compras: proveedor nuevo ("+ Proveedor nuevo…"), "Llega a: Bodega", un producto con
      50 piezas a $55. En Inventario → Bodega aparecen las 50; Tienda no cambia.
- [ ] Movimiento de bodega: Bodega → Tienda, agrega ese producto con 60: avisa "Solo hay 50
      en bodega" y no deja revisar. Cambia a 5, Revisar, Confirmar: Tienda +5, Bodega −5, y
      el historial del movimiento muestra de qué lote salieron.
- [ ] Invertir (Tienda → Bodega) y mueve 2: salen del lote más nuevo de la tienda.
- [ ] Con un producto con 0 en tienda y piezas en bodega: en Inventario (en cualquier filtro)
      aparece como sin stock en tienda con "Hay N en bodega". En el Mostrador no deja
      agregarlo y el aviso dice cuántas hay en bodega.
- [ ] Inventario inicial: la sesión empieza en Tienda. Cambia a Bodega (el recuadro se pone
      amarillo), escanea 3 veces un código: Bodega +3 en un solo lote. Deshacer quita la última.
- [ ] "Fijar total" a menos piezas en un producto con varios lotes: pide elegir el lote.
- [ ] Editar producto → Ajustar existencias → Bodega, cantidad menor: si hay varios lotes
      pide elegir; el lote elegido baja y la tienda no cambia.
- [ ] Con el usuario de mostrador no aparecen Compras ni Movimiento de bodega.
- [ ] Compras: abre la compra y "Corregir" el costo mientras está intacta; después de moverla
      solo deja cambiar folio y notas, y "Cancelar compra" ya no aparece.

- [ ] Compras: elige proveedor, escanea dos veces el mismo producto: un solo renglón con
      cantidad 2. Escanea un código que no existe: abre "Producto nuevo" sin cantidad
      inicial; al guardarlo aparece como renglón con el costo capturado.
- [ ] Compras sin Wi-Fi: registra la compra. Dice "guardada sin conexión", aparece arriba de
      la lista como "Pendiente de sincronizar" y las piezas ya se ven en Inventario. Al
      volver el internet se registra sola (una sola vez) y queda en la lista normal.
- [ ] Conteo y ajustes: sin motivo, escanear dice "Elige el motivo". Con "Merma" y fijar
      total a menos piezas: pide el lote. En Historial aparece como Ajuste con
      "Motivo: Merma". Un código que no existe avisa que se registre en Compras.
- [ ] Configuración → Inventario inicial → Cerrar: desaparece "Inventario inicial" del menú,
      "Nuevo producto" (Inventario) ya no pide cantidad inicial y `/inventario-inicial`
      dice que ya se cerró. "Volver a abrir" lo regresa.

## 14. Código de cliente
Antes: aplica la migración `…20261030000400_codigo_clientes.sql`.
- [ ] Cliente nuevo solo con nombre: el campo "Código de cliente" y "Generar" están
      deshabilitados y dice "Para vincular un código, llena correo y teléfono". Se guarda sin código.
- [ ] Llena correo y teléfono, presiona "Generar": aparece 10000001 (o el siguiente al mayor
      asignado). Guarda: el perfil muestra el código de barras.
- [ ] Edita otro cliente con correo y teléfono, escanea una tarjeta en el campo de código: no
      guarda solo con el Enter del lector. Escribe `20000000` o `1234`: avisa que debe tener
      8 dígitos y empezar con 1.
- [ ] Usa un código que ya tiene otro cliente: "Ese código ya está vinculado a otro cliente."
- [ ] Borra el correo de un cliente con código: no deja guardar hasta quitar el código o
      volver a llenar el correo.
- [ ] Clientes: la búsqueda encuentra por código y la tabla muestra la columna Código.
- [ ] Mostrador: con un ticket abierto escanea la tarjeta en el campo de productos: el cliente
      queda asignado ("Cliente asignado: …"). También funciona en el buscador de cliente.
