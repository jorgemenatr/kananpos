# Kanan POS

Punto de venta e inventario para tiendas (TCG, accesorios y más), en
[kananpos.com](https://kananpos.com). Cada cliente entra por su subdominio
(`hachiko.kananpos.com`) y tiene su propio proyecto de Supabase (ver
[Varios clientes](#varios-clientes-saas)). Funciona con lector de código de barras USB
y sigue capturando sin internet.

**Stack:** Vite + React + TypeScript · Tailwind CSS · Supabase (Postgres, Auth, Storage)
· React Router · SheetJS · JsBarcode · Netlify.

---

## Puesta en marcha

### 1. Crear el proyecto en Supabase

1. Entra a <https://supabase.com/dashboard> → **New project**.
2. Elige nombre (`kananpos-<subdominio>`, p. ej. `kananpos-hachiko`), contraseña de la base de datos y la región más cercana
   (p. ej. *East US* o *West US*).
3. Espera a que termine de aprovisionarse.

### 2. Desactivar el registro público

La app **no** tiene pantalla de "crear cuenta". Además, hay que cerrar el registro en Supabase,
porque si no cualquiera con la anon key podría crear un usuario por la API:

1. **Authentication → Sign In / Providers** (en algunas versiones del dashboard: *Authentication → Settings*).
2. Desactiva **Allow new users to sign up**.
3. Verifica que el proveedor **Email** esté habilitado (es el que usa el login con correo y contraseña).
4. Guarda.

### 3. Correr las migraciones

Las migraciones están en `supabase/migrations/` y deben aplicarse **en orden**:

| Archivo | Contenido |
| --- | --- |
| `20261012000100_esquema.sql` | Tipos, tablas `profiles`, `products`, `inventory_movements`, la secuencia `HCH-` y los triggers |
| `20261012000200_seguridad_rls.sql` | Permisos y políticas RLS |
| `20261012000300_funciones_rpc.sql` | RPC `register_scan`, `create_product`, `undo_movement`, `inventory_totals` y la vista `movement_history` |
| `20261012000400_storage.sql` | Bucket privado `product-images` y sus políticas |
| `20261012000500_catalogo_tcg.sql` | Tabla `catalog_products`, vínculo en `products`, RPC `search_catalog` y `catalog_status` |
| `20261013000100_catalogo_busqueda_accesorios.sql` | Búsqueda con palabras en español (micas, tapete, carpeta, colores…) |
| `20261013000200_clientes.sql` | Tabla `customers` (clientes) y sus permisos |
| `20261013000300_ventas.sql` | Tablas `tickets` y `ticket_items`, RPC `pay_ticket` y vista `sales_history` |
| `20261013000400_creditos.sql` | Créditos de tienda (`customer_credit_movements`, `grant_credits`) y pagos con varios métodos (`ticket_payments`) |
| `20261013000500_folio_tickets.sql` | Folio consecutivo de tickets ("Ticket 1, 2, 3…") asignado al cobrar |
| `20261013000600_folio_where.sql` | Corrección: el contador de folios necesita `WHERE` (Supabase rechaza `UPDATE` sin `WHERE`) |
| `20261015000100_roles_usuarios.sql` | Roles **admin** y **mostrador** (`staff` → `mostrador`), `is_admin()` y candados: solo admin agrega/edita inventario y usuarios |
| `20261015000200_categorias.sql` | Acomoda las categorías existentes a la lista fija (TCG con sus juegos, Accesorios, Cafetería, …) |
| `20261015000300_puntos_liga.sql` | Puntos de liga (`customer_league_points`, `grant_league_points`, vistas de total e historial) |
| `20261015000400_correcciones_inventario.sql` | Correcciones con motivo: `unlink_product` (desvincular código/catálogo), `cancel_movement`, `adjust_stock`; el historial muestra lo cancelado |
| `20261019000100_lotes_ubicaciones.sql` | **Lotes y dos ubicaciones** (tienda y bodega): `suppliers`, `lots`, `lot_stock`, `movement_lots`, compras (`register/update/cancel_purchase`), movimiento de bodega (`create_transfer`), escaneo/alta/ajuste por ubicación y lote, `pay_ticket` por FIFO y solo con stock en tienda. Migra el stock existente a un lote inicial en tienda por producto |
| `20261019000200_vista_costos.sql` | Vista `product_costs` (el admin lee de ahí el costo) y las funciones ya no devuelven el costo a quien no es admin |
| `20261019000300_costo_solo_admin.sql` | El rol de la app ya no puede leer `products.cost` (aplicar cuando la app publicada ya use `product_costs`) |
| `20261020000100_configuracion_negocio.sql` | Tabla `app_settings`: nombre del negocio y prefijo de los códigos internos (`HCH-`), para tener [varios clientes](#varios-clientes-saas). Las bases que ya existían quedan como Hachiko / `HCH` |
| `20261020000200_categorias_configurables.sql` | Categorías por negocio (`product_categories`) ligadas a juegos del catálogo; `catalog_products.source`; la búsqueda del catálogo solo muestra lo que se vende. Aplicar **antes** de publicar la app nueva |
| `20261029000100_nombre_tickets.sql` | El nombre del ticket es solo el folio (`140` en vez de `Ticket 140`); la app muestra "140. Cliente". Se puede aplicar antes o después de publicar |
| `20261030000400_codigo_clientes.sql` | Código de cliente opcional (`customers.code`): 8 dígitos que empiezan con 1, único, y solo si el cliente tiene correo y teléfono. Aplicar **antes** de publicar la app nueva |
| `20261031000100_preventas_tickets_compartidos.sql` | **Mostrador:** tickets abiertos compartidos entre dispositivos (`open_tickets`, `open_ticket_lines`, realtime); **preventas** (`products.is_preorder` + anticipo, `preorder_reserved`, status `preorder`, abonos con fecha en `ticket_payments`); combos con refresco (`product_combo_options`); cancelaciones con registro (`cancel_ticket`, `cancel_open_ticket`); notas (`tickets.notes`) y nombre libre (`tickets.customer_name`); apodos de clientes; día de operación configurable (`app_settings.day_cutoff_hour`, `business_date`). RPC nuevas: `checkout_ticket`, `add_ticket_payment`. Aplicar **antes** de publicar la app nueva (la anterior sigue funcionando) |
| `20261031000200_reservas_preventa.sql` | Vista `product_reservations` (piezas comprometidas en preventas). Corrige "permission denied for table products" al editar productos y recargar el catálogo. Aplicar **antes** de publicar la app nueva |
| `20261031000300_combos_grupo_bebidas.sql` | Combos con grupo de bebidas: `products.is_combo` y `app_settings.combo_drinks_category` (la categoría cuyos productos son las bebidas a elegir). `checkout_ticket` valida la bebida contra ese grupo; `product_combo_options` deja de usarse. Compatible con la app anterior |
| `20261102000100_idioma_producto.sql` | Idioma del producto (`products.language`: inglés, español, japonés, chino o sin idioma) y `create_product` con `p_language`. Etiqueta los productos actuales ("ESPAÑOL"/"Japones" en el nombre → ese idioma, y quita la palabra del nombre; el resto de Pokémon → inglés). Aplicar **antes** de publicar la app nueva |
| `20261106000200_desactivar_usuarios.sql` | **Desactivar usuarios:** `user_access_status()` (estado de acceso, solo admin), `revoke_user_sessions()` (solo `service_role`), `check_request()` como `pgrst.db_pre_request` (la API rechaza al instante a un usuario desactivado) y `keep_one_admin` exige un admin **activo**. Se puede aplicar antes o después de publicar la app |

**Opción A: SQL Editor (lo más sencillo).** En el dashboard ve a **SQL Editor → New query**,
pega el contenido de cada archivo en orden y presiona **Run**.

**Opción B: Supabase CLI.**

```bash
npx supabase login
npx supabase link --project-ref <ID-DEL-PROYECTO>   # el ID está en la URL del dashboard
npx supabase db push
```

### 4. Crear el primer usuario

1. **Authentication → Users → Add user → Create new user**.
2. Escribe correo y contraseña y marca **Auto Confirm User**. Si no lo marcas, el login dirá
   que el correo no está confirmado.
3. El perfil se crea solo en `public.profiles` con rol `mostrador` (lo hace un trigger).
4. Haz administradora a esa primera cuenta en el SQL Editor:

   ```sql
   update public.profiles set role = 'admin' where email = 'tu-correo@ejemplo.com';
   ```

   (La migración `20261015000100_roles_usuarios.sql` hace admin a los usuarios que ya
   existían si todavía no había ningún admin.)

Las demás personas se dan de alta desde la app en **Usuarios** (ver
[Usuarios y roles](#usuarios-y-roles)). Para quitar el acceso a alguien, desactívalo ahí
mismo (**Usuarios → lápiz → Desactivar usuario**).

### 4b. Publicar las Edge Functions `crear-usuario` y `desactivar-usuario`

La pantalla **Usuarios** crea y desactiva cuentas con Edge Functions, porque eso
necesita la `service_role` key y esa nunca puede ir en el navegador.

| Función | Hace |
| --- | --- |
| `crear-usuario` | Crea la cuenta (correo, nombre, rol y contraseña temporal) |
| `desactivar-usuario` | Bloquea o devuelve el acceso de una cuenta y cierra sus sesiones |

**Opción A: dashboard.** Por cada función: **Edge Functions → Deploy a new function → Via
Editor**, ponle el nombre de la función, pega el contenido de
`supabase/functions/<nombre>/index.ts` y presiona **Deploy**. Deja activado **Verify JWT**
(la función además revisa que quien la llama sea admin).

**Opción B: Supabase CLI.**

```bash
npx supabase functions deploy crear-usuario
```

```bash
npx supabase functions deploy desactivar-usuario
```

Con varios clientes: `npm run clientes -- funciones` despliega las dos en todos.

No hay que configurar secretos: Supabase le da a la función `SUPABASE_URL`,
`SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`.

### 5. Variables de entorno

Copia `.env.example` a `.env.local` y llena los valores de **Project Settings → API**:

```bash
VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...   # la "anon" / "publishable" key
```

> ⚠️ **Nunca** pongas la `service_role` (o *secret*) key en el frontend ni en Netlify. Todo lo
> que empieza con `VITE_` termina en el JavaScript público. La anon key es segura de exponer
> porque toda la protección está en RLS.

### 6. Correr la app en local

Requiere Node 20 o superior (recomendado 22).

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # verifica tipos y genera dist/
```

#### Modo demo (sin Supabase)

Para revisar la interfaz (p. ej. en el celular) con datos inventados, sin tocar ninguna base:

```bash
npm run dev:demo     # http://localhost:5173 y la IP de la red local
```

- Entra con cualquier correo y contraseña. Si el correo contiene `mostrador` entras con ese
  rol; si no, como administrador.
- Para abrirlo en el celular, conéctalo a la misma red WiFi y abre la dirección `Network:`
  que imprime Vite (p. ej. `http://192.168.1.20:5173`).
- Las altas, cambios y cobros se guardan solo en memoria y se pierden al recargar. Lo que el
  simulador no cubre (subir fotos, compras, ajustes, etc.) muestra "no está disponible en modo demo".
- Los datos están en `src/lib/demo/demoApi.ts` y su configuración en `.env.demo`. Ese código
  solo se incluye con `--mode demo`; no va en el build de producción.

### 7. Publicar en Netlify

1. En Netlify: **Add new site → Import an existing project** y conecta este repositorio.
2. Netlify toma la configuración de `netlify.toml`: `npm run build`, carpeta `dist` y
   redirección SPA para que `/historial` y `/etiqueta/...` funcionen al recargar.
3. En **Site configuration → Environment variables** agrega `VITE_SUPABASE_URL` y
   `VITE_SUPABASE_ANON_KEY`, y vuelve a desplegar (las variables se leen en el *build*).
4. Netlify sirve en HTTPS, que es lo que necesita la webcam (`getUserMedia`).
5. Opcional: en Supabase, **Authentication → URL Configuration → Site URL**, pon la URL de
   Netlify.

### 8. Cargar el catálogo TCG

Ver [Catálogo TCG](#catálogo-tcg). Se hace una vez al inicio y luego se mantiene solo (o
a mano con cada expansión).

---

## Varios clientes (SaaS)

Cada cliente tiene **su propio proyecto de Supabase** (su base de datos, usuarios e
imágenes). Todos usan **un solo sitio de Netlify** y el mismo código: la app ve el
subdominio (`hachiko.kananpos.com`) y busca en **`src/tenants.json`** a qué proyecto
conectarse. Cada cambio se construye una sola vez para todos.

`src/tenants.json` guarda, por subdominio, el nombre, la URL del proyecto, su **anon key**
(pública por diseño: los permisos los pone RLS; **nunca** una service_role) y el estado
(`activo` o `suspendido`). Lo mantiene `npm run clientes`. Además:

- `kananpos.com` y `www.` muestran una página de presentación; un subdominio que no está
  en el registro muestra "Este negocio no existe"; uno `suspendido`, un aviso en lugar de
  la app.
- Fuera del dominio (`localhost`, `*.netlify.app`, deploy previews) se usan las variables
  `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, como antes. En local,
  `VITE_TENANT=hachiko` simula estar en ese cliente.
- En Netlify, cada cliente es un alias del sitio (`tienda.kananpos.com` en **Domain
  management → Add domain alias**). El dominio usa Netlify DNS y el certificado ya cubre
  `*.kananpos.com`, así que no hace falta tocar el DNS.

Lo que cambia entre clientes dentro de su base vive en la tabla `app_settings`:

| Campo | Para qué |
| --- | --- |
| `business_name` | Nombre que muestra la app ("*Nombre* · Kanan POS"), el título de la pestaña y los archivos exportados |
| `internal_code_prefix` | Prefijo de los códigos internos (`DRG-000001`). 2 a 5 letras. Ya no se puede cambiar en cuanto existe un producto con código interno (las etiquetas impresas lo llevan) |

Todo se administra con `npm run clientes` (`scripts/clientes.mjs`), que usa la
[Management API de Supabase](https://supabase.com/docs/reference/api/introduction):

1. Crea un token personal en <https://supabase.com/dashboard/account/tokens> (acceso a
   toda la organización).
2. Copia `.env.clientes.example` a `.env.clientes` y pon el token. ⚠️ El token da acceso a
   todos tus proyectos: nunca en Netlify ni en variables `VITE_`.

### Dar de alta un cliente

1. En Supabase: **New project** con el nombre `kananpos-<subdominio>` (p. ej.
   `kananpos-dragon-rojo`, así todos los clientes quedan juntos y en orden en el
   dashboard), contraseña y región. Espera a que esté listo. El ID del proyecto es el de
   la URL del dashboard.
2. Corre:

   ```bash
   npm run clientes -- alta --ref <ID> --subdominio dragon-rojo --negocio "Dragón Rojo" \
     --prefijo DRG --admin-correo duena@dragonrojo.mx --admin-nombre "Ana López" \
     --juegos pokemon,one-piece,dragon-shield --categorias "Cafetería,Juegos de mesa"
   ```

   Esto cierra el registro público, apunta la Site URL de Auth a su subdominio, corre
   todas las migraciones, guarda el nombre y el prefijo, crea las categorías (los juegos como subcategorías de **TCG**, las marcas de
   accesorios en **Accesorios** y las de `--categorias` como principales), despliega la
   funciones (`crear-usuario`, `desactivar-usuario`), crea al primer admin (imprime su contraseña temporal; la app le pide cambiarla al entrar), carga el
   catálogo **solo de sus juegos** y lo agrega a `src/tenants.json`. Se puede volver a
   correr si algo falla a medias. Las categorías se cambian después en **Configuración**.
3. Commit y push a `main`. Al publicar Netlify, el cliente ya entra en
   `dragon-rojo.kananpos.com` (antes, agrega ese alias en Netlify → **Domain management**).

Para cortar o devolver el acceso: `npm run clientes -- suspender --subdominio dragon-rojo`
(o `reactivar`), commit y push.

### Publicar una versión nueva

- **Frontend:** al hacer merge a `main`, Netlify publica el sitio (uno para todos).
- **Base de datos:** `npm run clientes -- estado` muestra qué migraciones le faltan a cada
  cliente y `npm run clientes -- migrar` las aplica (cada una en su transacción; si una
  falla en un cliente, ese cliente queda en la anterior y los demás siguen). También desde
  GitHub: **Actions → Actualizar clientes → Run workflow** (por defecto solo lista lo
  pendiente). Lee el encabezado de cada migración nueva: algunas deben esperar a que
  Netlify publique la app.
- **Edge Functions:** `npm run clientes -- funciones`.

El registro de migraciones es el mismo que usa `supabase db push`
(`supabase_migrations.schema_migrations`), así que ambas formas son compatibles.
`--ref <ID>` limita cualquier comando a un solo cliente; los comandos usan los clientes de
`src/tenants.json` (o los IDs de `CLIENTES`, si la defines).

Secret en GitHub para los workflows: `SUPABASE_ACCESS_TOKEN`. Con él, el workflow del
catálogo importa en todos los clientes del registro.

### Respaldos

El workflow **Respaldo de clientes** respalda la base de todos los clientes cada día (y
además las fotos los domingos) en un archivo cifrado (necesita además el secret `BACKUP_PASSPHRASE`). Cómo
abrirlos y restaurar un cliente: [`docs/RESPALDOS.md`](docs/RESPALDOS.md).

---

## Usuarios y roles

| Rol | Puede |
| --- | --- |
| **Administrador** (`admin`) | Todo: vender, clientes, créditos, puntos de liga, **inventario** (inventario inicial, compras, conteo y ajustes, altas), **editar productos** y administrar usuarios |
| **Mostrador** (`mostrador`) | Vender, clientes, créditos y puntos de liga. **No** puede agregar ni editar inventario (no ve *Inventario inicial*, *Compras*, *Conteo y ajustes* ni el lápiz de editar) |

La regla se aplica también en la base de datos (triggers en `products` e
`inventory_movements`), no solo escondiendo botones. Las ventas descuentan stock con
cualquier rol.

En **Usuarios** (solo admin) se crea una cuenta con nombre, correo, rol y una contraseña
temporal que le compartes a la persona. Ahí mismo se cambia el nombre o el rol; siempre
debe quedar al menos un administrador activo.

**Contraseñas.** Mínimo 10 caracteres, con letras y números (la temporal también). Al
entrar por primera vez con la contraseña temporal, la app pide cambiarla (marca
`must_change_password` en el `user_metadata`, que pone `crear-usuario`). Cualquier
usuario cambia la suya cuando quiera con el botón de la llave junto a su nombre, en el
menú: pide la contraseña actual y la nueva dos veces. Si alguien olvida su contraseña, un
admin puede mandarle un correo de recuperación desde **Authentication → Users** en Supabase.

**Desactivar a alguien que ya no trabaja aquí.** **Usuarios → lápiz → Desactivar usuario**
(solo admin). La lista muestra quién está **Activo** o **Desactivado**. Al desactivar:

- La Edge Function `desactivar-usuario` lo bloquea en Auth (`ban_duration: '876000h'`) y
  borra sus sesiones (`revoke_user_sessions`): no puede volver a entrar ni renovar su sesión.
- La base rechaza de inmediato cualquier petición suya, aunque su token todavía no venza
  (`check_request`, configurada como `pgrst.db_pre_request`). La app lo saca a la pantalla
  de inicio de sesión. (Las fotos de Storage y el tiempo real no pasan por ahí: su token
  deja de servir para eso cuando vence, en máximo 1 hora.)
- Sus ventas, movimientos y demás registros se conservan.
- Nadie se puede desactivar a sí mismo, ni desactivar al último administrador activo.

**Reactivar usuario** (mismo lugar) le devuelve el acceso con su misma contraseña.

## Categorías de producto

Cada negocio define sus categorías en **Configuración** (solo admin): categorías
principales y, si hace falta, un nivel de subcategorías (p. ej. **TCG** → Pokémon, Magic…).
Se pueden agregar, renombrar (sus productos se cambian solos), reordenar y borrar (solo si
no tienen productos ni subcategorías). Viven en la tabla `product_categories`; en
`products.category` se guarda el texto (`TCG · Pokémon`).

A cada categoría se le pueden ligar **juegos o marcas del catálogo TCGplayer** (lista en
`src/lib/catalogSources.json`). Eso decide dos cosas:

- **Qué se precarga del catálogo:** solo los juegos ligados (si una tienda no vende
  Yu-Gi-Oh!, su catálogo no lo trae ni lo muestra el buscador).
- **La categoría sugerida** al vincular un producto del catálogo.

En Hachiko, la migración dejó las de siempre (TCG con sus 5 juegos, Accesorios con Dragon
Shield y Ultra Pro, Cafetería, Comida, Juegos de Mesa, Torneos). En Inventario se filtra con
los botones de categoría (y por subcategoría). Para editar un producto (nombre, precio, costo, categoría, proveedor,
descripción y foto), un admin usa el lápiz en la tarjeta o el renglón. La cantidad no se
edita ahí: cambia con escaneos y ventas para que quede en el historial.

## Correcciones de inventario

Solo admin. Todas piden un **motivo** y quedan en el **Historial** con quién y cuándo;
nunca se borra un movimiento.

- **Cancelar un movimiento** (Historial → *Cancelar*): alta, escaneo o ajuste. Se registra
  una *Cancelación* que revierte la cantidad y el original queda marcado como **Cancelado**.
  Las ventas no se cancelan desde aquí.
- **Ajustar existencias** (Editar producto → *Ajustar existencias*): pones la cantidad
  correcta y el motivo.
- **Desvincular código** (Editar producto → *Desvincular código*): el producto se queda
  con un código interno `HCH-` (imprime su etiqueta nueva) y pierde el vínculo con el
  catálogo. El código real queda libre: al escanearlo en *Compras* se toma como nuevo y,
  como ya se había desvinculado, no se vincula solo al catálogo: avisa y se elige el
  producto correcto a mano. Si el producto ya tenía código interno, solo se quita el
  vínculo con el catálogo.

## Puntos de liga

Cada cliente tiene un total de **puntos de liga**. Se agregan desde el perfil del cliente
o desde **Clientes** (menú **⋯** → *Agregar puntos de liga*, para uno o varios a la vez). Cada registro guarda cantidad, comentario, fecha y quién los asignó (el
usuario con sesión iniciada). Para corregir, se registran puntos negativos.

## Catálogo TCG

Para no capturar a mano nombre, foto y descripción del producto sellado, la app tiene una
copia del catálogo de **TCGplayer** (vía [tcgcsv.com](https://tcgcsv.com), un espejo
público y gratuito que se actualiza a diario). Incluye **producto sellado** (cajas,
sobres, ETB, blisters, mazos, latas…, sin cartas sueltas) y **accesorios**:

Cada negocio solo carga los juegos que liga a sus categorías (ver
[Categorías de producto](#categorías-de-producto)). Además de estos hay One Piece, Digimon,
Dragon Ball, Star Wars: Unlimited, Gundam, Riftbound, Union Arena, Weiss Schwarz, Vanguard
y otros (`src/lib/catalogSources.json`).

| Fuente (`--juegos`) | Qué trae | Productos aprox. | Con código de barras |
| --- | --- | --- | --- |
| `pokemon` | Pokémon (inglés), sellado | 2,900 | ~950 |
| `magic` | Magic: The Gathering, sellado | 3,800 | ~1,050 |
| `yugioh` | Yu-Gi-Oh!, sellado | 1,200 | ~440 |
| `lorcana` | Disney Lorcana, sellado | 180 | — |
| `flesh-and-blood` | Flesh and Blood, sellado | 230 | — |
| `dragon-shield` | **Todo** Dragon Shield: micas, deck boxes, playmats, carpetas, páginas, contadores | 800 | ~130 |
| `ultra-pro-pokemon` | Ultra Pro **solo de Pokémon** (por nombre o por el tema del producto en TCGplayer): carpetas, portafolios, deck boxes, micas, playmats | 440 | ~45 |
| `ultra-pro` | Ultra Pro **sin licencia** (nada de Magic, Pokémon, Warhammer, D&D, artistas…): colores lisos, Eclipse, Vivid, toploaders, one-touch, páginas, carpetas | 980 | ~240 |

(Cifras de octubre de 2026.)

### Cómo funciona al escanear

1. Escaneas un código que no está en el inventario y se abre **Producto nuevo**.
2. Si ese código viene en el catálogo, el producto se **vincula solo** ("Encontrado en el
   catálogo por código de barras"). Pasa con parte de Magic, Yu-Gi-Oh! y Pokémon.
3. Si no, el cursor queda en **Buscar en el catálogo TCG**. Escribe palabras del nombre en
   cualquier orden, como aparecen en TCGplayer (en inglés): `delta reign etb`,
   `151 booster bundle`, `bloomburrow play box`. También entiende `etb`, `upc`
   (Ultra Premium Collection), `caja`, `sobre`, `mazo` y `lata`, y para accesorios
   `micas`, `carpeta`, `tapete`, `portafolio`, `bolsillos`, `mate` y los colores
   (`micas negras mate dragon`, `tapete pikachu`, `carpeta charizard 9 bolsillos`).
   Flechas para moverte y Enter para elegir.
4. Se llenan **nombre, categoría (la que tiene ese juego ligado), descripción y foto**. Tú solo pones precio,
   costo y cantidad, y guardas. El nombre y la descripción se pueden editar (p. ej. agregar
   "(español)").
5. A partir de ahí ese código de barras queda ligado al producto. **El vínculo se hace una
   sola vez por SKU**, no por pieza.

Detalles:

- La foto se **descarga y se guarda en el bucket propio** (`product-images`), igual que una
  foto tomada con la cámara. No depende de TCGplayer después del alta. Si subes o tomas una
  foto propia, tiene prioridad sobre la del catálogo.
- El precio de TCGplayer (en dólares) se muestra **solo como referencia**; no llena el
  precio de venta.
- Si eliges un producto del catálogo que ya está vinculado a otro código, la app avisa
  ("Ya está en inventario con el código …"), pero te deja continuar: hay productos que
  tienen dos códigos (p. ej. otra impresión o idioma).
- **Producto en español:** TCGplayer cataloga la versión en inglés. Para producto en
  español, vincula la versión en inglés equivalente (misma caja, mismo set) y ajusta el
  nombre si quieres. La foto será la de la caja en inglés.
- Sin internet no se puede buscar en el catálogo; el alta se hace a mano como antes.

### Cargar o actualizar el catálogo

**¿Hay que hacerlo con cada expansión nueva?** Sí: el catálogo es una copia, así que los
productos de una expansión aparecen hasta que se vuelve a importar. TCGplayer suele
publicar el producto sellado unas semanas **antes** del lanzamiento (preventa), así que
normalmente ya está cuando llega la mercancía. Hay dos formas, y **la importación es
segura de repetir**: actualiza lo que ya existe, agrega lo nuevo y nunca borra, así que
los productos ya vinculados no se pierden.

Ambas usan la **service_role key** de Supabase (*Project Settings → API*, "service_role" o
"secret"). Esa llave se salta todos los permisos: **nunca** la pongas en Netlify, en
variables `VITE_` ni en el código de la app.

**Opción A: automática con GitHub Actions (recomendada).** Se actualiza sola cada lunes.

1. En GitHub, en el repositorio: **Settings → Secrets and variables → Actions → New
   repository secret**. Crea dos:
   - `SUPABASE_URL`: la URL del proyecto (`https://xxxx.supabase.co`).
   - `SUPABASE_SERVICE_ROLE_KEY`: la service_role key.
2. Ve a la pestaña **Actions → Importar catálogo TCG → Run workflow** para la primera carga
   (tarda menos de un minuto). Al terminar, el resumen muestra cuántos productos importó
   por juego.
3. Ya no hay que hacer nada: corre cada lunes. Si sale una expansión a media semana y la
   necesitas ya, repite el paso 2.

**Opción B: a mano desde una computadora** (Node 22 o superior).

```bash
cp .env.catalogo.example .env.catalogo   # y llénalo (está en .gitignore)
npm run catalogo                          # los juegos ligados a las categorías del negocio
npm run catalogo -- --juegos pokemon      # solo un juego
npm run catalogo -- --desde 2026-01-01    # solo sets publicados desde esa fecha (no aplica a accesorios)
npm run catalogo -- --juegos dragon-shield,ultra-pro-pokemon   # solo accesorios
npm run catalogo -- --prueba              # descarga sin escribir en Supabase (catalogo-prueba.json)
```

En la app, el buscador muestra cuántos productos tiene el catálogo y la fecha de la última
importación.

**Agregar otro juego o marca** (p. ej. One Piece o Ultimate Guard): súmalo a `JUEGOS` en
`scripts/importar-catalogo.mjs` con su `categoryId` de TCGplayer (la lista está en
<https://tcgcsv.com/tcgplayer/categories>) y vuelve a importar. Para accesorios se filtra
por el nombre del grupo (la marca) y, si quieres, por el nombre del producto, como se
hace con Ultra Pro y Pokémon.

---

## El día del escaneo

### Configurar el lector

- El lector debe mandar **Enter** al final de cada código (sufijo CR). Casi todos vienen así
  de fábrica.
- **Distribución de teclado:** muchos lectores "teclean" como un teclado de EE. UU. Si la
  laptop está en *Español (Latinoamérica)*, el guion de `HCH-000001` puede llegar como
  `HCH'000001`. La app lo corrige sola para los códigos internos. Aun así, la primera prueba
  con el lector real debe ser escanear una etiqueta `HCH-` impresa. Si otros códigos con
  símbolos salen mal, configura el lector para que use la misma distribución que la laptop
  (viene en el manual del lector, con códigos de configuración).
- Haz una prueba de escaneo después de cada cambio de configuración.

### Probar sin lector

Abre la app con `?simulador=1` para mostrar un **simulador de lector**: escribe códigos a
velocidad de lector en el campo con foco y manda Enter. Se apaga con `?simulador=0`. Detalles en
[`docs/PRUEBAS_MANUALES.md`](docs/PRUEBAS_MANUALES.md).

### Cómo se usa

- **Sumar** con cantidad `1`: escanea pieza por pieza. Con `24`: "tengo 24 de estos".
- **Fijar total**: cada escaneo deja la cantidad del producto en el valor indicado (para corregir).
- **Código desconocido**: se abre el formulario con el código ya puesto. Nombre y precio son
  obligatorios. *Enter* guarda y *Esc* cancela.
- **Producto sin código**: genera `HCH-000001`, `HCH-000002`, … y ofrece imprimir una etiqueta
  Code128 de 50 × 30 mm (ajusta la escala en el diálogo de impresión si tu etiqueta es de otro tamaño).
- **Deshacer último escaneo**: revierte el escaneo más reciente de la sesión con un movimiento de
  ajuste. Si lo presionas otra vez, deshace el anterior.
- El foco regresa solo al campo de escaneo. Si el lector "escribe" por accidente en el campo
  de cantidad, la app lo detecta y lo procesa como escaneo. Si pasa dentro del formulario de
  producto nuevo, lo ignora y avisa, para que no se guarde un código como nombre.

---

## Menú

El menú lateral queda: **Mostrador · Ventas · Clientes · Inventario**. Al entrar a Inventario
aparecen sus subsecciones (todas menos Historial, solo para administradores):

- **Inventario inicial** (`/inventario-inicial`): el primer conteo del negocio. Escaneo
  libre (sumar / fijar total), altas con cantidad inicial y, si se quiere, proveedor y
  costo del lote. Se puede hacer por partes: lo contado se queda guardado. **Solo aparece
  mientras el inventario inicial está abierto**; cuando el cliente avisa que terminó, un
  admin lo cierra en **Configuración → Inventario inicial** (y lo puede volver a abrir).
- **Compras** (`/compras`): la mercancía que llega de un proveedor, con su costo y folio.
  Se captura con el lector: escanear otra vez el mismo producto suma una pieza, y un
  código que no existe abre el alta ahí mismo (sin cantidad: las piezas entran con la
  compra). **Funciona sin conexión**: la compra se guarda en la cola y se registra sola
  al volver el internet (el id de la compra evita duplicarla).
- **Conteo y ajustes** (`/conteo`): corregir lo que hay (conteo físico, merma, dañado,
  error…). Cada escaneo lleva un **motivo** obligatorio y queda como *Ajuste* en el
  historial; lo que sube entra con el último costo y proveedor del producto, y lo que baja
  pide el lote. No da de alta productos. `/agregar` redirige aquí.
- **Movimiento de bodega** e **Historial**.

En **Inventario**, el botón **Nuevo producto** da de alta productos que no se compran
(comida, torneos) o sin compra; la cantidad inicial solo se pide mientras el inventario
inicial está abierto. Con el inventario inicial cerrado, la base ya no acepta escaneos
sin motivo ni altas con cantidad inicial. Al iniciar sesión la app abre en el **Mostrador**.

## Tienda, bodega y lotes

Cada producto tiene piezas en **Tienda** (donde se vende) y en **Bodega**. Las piezas
vienen en **lotes**: cada lote es una entrada de mercancía con su **proveedor**, su
**costo unitario** y su fecha, así que el mismo producto puede tener piezas de distintos
proveedores y a distintos costos, en cualquiera de las dos ubicaciones.

- **Cuándo se crea un lote:** cada renglón de una **compra**; cada **sesión de escaneo**
  (los escaneos de una misma sesión suman al mismo lote por producto); el **alta** de un
  producto con cantidad inicial; un **ajuste hacia arriba**. El stock que había antes de
  los lotes quedó como un lote "Inventario inicial" en tienda con el costo del producto
  ($0 si no tenía).
- **Ventas:** salen solo de la tienda, del lote más viejo (FIFO). El cajero no elige nada.
  Si la tienda no alcanza, la venta se rechaza aunque haya en bodega (el aviso dice cuánto
  hay en bodega para pedir un movimiento). **Solo se cobra con conexión.**
- **Movimiento de bodega** (`/movimiento-bodega`, solo admin): Bodega → Tienda por defecto
  (botón para invertir), uno o varios productos, todo o nada. Bodega → tienda mueve primero
  lo más viejo; tienda → bodega, lo más nuevo. Un error se corrige con otro movimiento en
  sentido contrario.
- **Compras** (`/compras`, solo admin): proveedor, folio, "Llega a" (Tienda por defecto) y
  renglones con cantidad y costo. Proveedor y costos se corrigen, o la compra se cancela,
  solo mientras ninguna pieza se haya vendido, movido o ajustado; folio y notas siempre.
- **Bajar existencias a mano** (ajuste, merma, "fijar total" hacia abajo): se elige de qué
  lote salen las piezas (si hay uno solo, se toma ese). Necesita conexión.
- **Quién ve qué:** lotes, costos (también el del producto), proveedores, compras y
  traspasos solo los lee un admin. El mostrador ve las cantidades por ubicación. Si se
  agrega una columna a `products`, hay que darle `SELECT` a `authenticated` (ver
  `20261019000300_costo_solo_admin.sql`).
- `products.quantity` (tienda) y `products.warehouse_quantity` (bodega) se calculan solas
  desde los lotes; nadie las escribe directo. La vista `stock_mismatches` debe estar
  siempre vacía (control de integridad), y `sale_item_profit` da la utilidad real por
  renglón de venta.
- Pruebas SQL locales (Postgres 16, nunca contra Supabase): `PGHOST=/tmp PGPORT=54329
  supabase/tests/run.sh`.

## Inventario

En **Inventario** (`/inventario`) se consultan los productos dados de alta:

- **Cuadrícula** (foto, nombre, precio y stock) o **Lista** (tabla con código, categoría,
  proveedor, stock y precio, ordenable con clic en el encabezado). La app recuerda la
  última vista elegida.
- Buscador (nombre, código, categoría o proveedor), filtro por categoría y por existencias.
- **Tienda | Bodega | Total** (por defecto Total) escoge qué existencias se muestran,
  suman, ordenan y exportan. "Sin stock" y "stock bajo" (2 piezas o menos) se calculan
  **siempre con la tienda**; si hay piezas en bodega aparece "Hay N en bodega".
- Arriba, el total de productos, piezas y valor a precio de venta de lo que está filtrado,
  y las alertas de tienda (clic para filtrarlas).
- Usa la misma copia local que Escaneo, así que también funciona sin conexión. Las fotos sí
  necesitan internet.

## Clientes

En **Clientes** (`/clientes`) se da de alta y se consulta a los clientes de la tienda:

- **Nombre** obligatorio; **correo** y **teléfono** opcionales.
- **Juegos que juega**: selección múltiple como tags. Un clic agrega o quita un juego de la
  lista (Pokémon, Magic, Yu-Gi-Oh!, Lorcana, Star Wars Unlimited…) y "Otro juego" permite
  escribir uno nuevo; los juegos que ya tiene algún cliente aparecen como opción para los
  demás.
- La lista se busca por nombre, correo o teléfono y se filtra por juego. Al abrir un
  cliente se ven sus datos y se pueden editar.
- Los clientes no se borran desde la app (solo desde el dashboard de Supabase), porque
  después tendrán ventas ligadas.

## Mostrador y ventas

### Mostrador (`/mostrador`)

1. **Abre un ticket** con "Nuevo ticket". Puede haber varios abiertos a la vez; en la
   columna izquierda se identifican por su cliente (o "Sin cliente"), la hora en que se
   abrieron, las piezas y el total. No llevan nombre: **al cobrarlos reciben su folio**
   ("Ticket 1", "Ticket 2", …), consecutivo y sin repetirse nunca. Las ventas cobradas sin
   conexión reciben su folio al sincronizarse.
2. **Asigna un cliente** (opcional): búscalo por nombre o teléfono, o dalo de alta ahí mismo
   con "Nuevo cliente".
3. **Agrega productos** con el lector (código + Enter) o escribiendo parte del nombre y
   eligiendo con flechas + Enter. La cantidad se cambia con − / + o escribiéndola.
4. Elige la **forma de pago** (efectivo, tarjeta, créditos o transferencia). Con un solo método,
   un clic cubre todo el total. Para **pagar con varios**, elige también el segundo: aparece el
   monto de cada uno y, con dos métodos, al cambiar uno el otro se ajusta para completar el
   total. En efectivo, si escribes lo recibido, calcula el cambio.
5. **Cobrar** registra la venta, descuenta el inventario y crea un movimiento "Venta" por
   producto (se ve en Historial). El ticket se cierra.

Reglas:

- **No se vende sin stock.** Lo que está en un ticket abierto queda **apartado**: si hay 3
  piezas y un ticket tiene 2, otro ticket solo puede llevar 1. Al pagar, el servidor
  vuelve a revisar el stock.
- Los tickets abiertos **viven en la computadora del mostrador** (hay un solo POS): no se
  pierden al recargar ni sin internet, pero no se ven desde otra computadora.
- Un ticket solo se puede eliminar si está vacío. Por ahora no hay cancelaciones ni
  descuentos, y no se desglosa IVA.

### Sin conexión

Sin internet se pueden abrir tickets, agregar productos (con el stock de tienda de la copia
local) y asignar clientes ya descargados, pero **no se puede cobrar**: el botón Cobrar se
desactiva hasta que vuelva la red. Si la red se cae a medio cobro, se puede volver a
presionar Cobrar: el id del ticket evita cobrar dos veces. Dar de alta clientes también
necesita conexión.

### Ventas (`/ventas`)

Historial de ventas cobradas con fecha, ticket, cliente, artículos, forma de pago y total.
Se filtra por fechas (por defecto, hoy) y forma de pago, con el total de ventas y la suma
por forma de pago. Al hacer clic en una venta se ven sus productos y quién cobró. Las
ventas que siguen en la cola sin conexión aparecen arriba como pendientes.

En el detalle de cada cliente, **Compras previas** muestra sus ventas con el total gastado.

Si una venta se pagó con más de un método, en la columna Pago dice **Mixto**; al abrirla se ve
cuánto se pagó con cada método. Los totales por forma de pago de arriba reparten las ventas
mixtas en sus métodos reales.

## Créditos de tienda

Cada cliente puede tener créditos (1 crédito = $1) para pagar productos en la tienda.

- **Agregar a un cliente:** en su perfil, **Agregar crédito** → monto y concepto (p. ej.
  "Premio torneo Pokémon"). Se guarda el monto, la fecha, el concepto y quién lo agregó.
- **Agregar a varios:** en **Clientes**, **Agregar créditos** → un concepto y la lista de
  clientes, cada uno con su monto (p. ej. los premios de un torneo).
- **Perfil del cliente:** saldo disponible, créditos ganados y usados (histórico) y el
  historial de movimientos. La lista de clientes muestra el saldo de cada uno.
- **Pagar con créditos:** en el Mostrador elige "Créditos". El ticket necesita un cliente;
  se muestra su saldo y no deja usar más de lo que tiene (si no alcanza, combínalo con otro
  método). Necesita conexión para leer el saldo real; los demás métodos funcionan sin red.
- Por ahora los créditos no se pueden quitar ni corregir desde la app: se registran al
  agregarlos y se descuentan al usarlos. Nada se edita ni se borra.

## Decisiones de diseño

### Modelo de datos

- `products.quantity` es el stock de **tienda** y `warehouse_quantity` el de **bodega**; las
  dos se calculan desde `lot_stock` (piezas de cada lote en cada ubicación). **Todo** cambio
  pasa por una RPC que mueve piezas de lotes, las anota en `movement_lots` e inserta el
  movimiento en la misma transacción (ver "Tienda, bodega y lotes").
- `inventory_movements` es *append-only* (sin UPDATE ni DELETE desde el cliente). Cada
  movimiento guarda `delta`, `quantity_after` y quién lo hizo (`created_by = auth.uid()`).
  El tipo `sale` ya existe en el enum para el POS.
- `client_op_id` (único) hace las RPC **idempotentes**: si la red se cae justo después de
  enviar un escaneo y la cola lo reintenta, no se cuenta dos veces.
- `reverts_movement_id` (único) liga cada "deshacer" con el movimiento que revierte. Así un
  movimiento no se puede deshacer dos veces.
- El prefijo `HCH-` está reservado: solo lo genera la secuencia. No se puede dar de alta
  a mano un código que empiece así.
- Precio y costo son `numeric(12,2)`. Las piezas de un lote nunca bajan de 0, así que el
  stock tampoco.

### Seguridad (RLS)

- RLS está activado en `profiles`, `products` e `inventory_movements`. Además se revocaron
  todos los privilegios de `anon`: sin sesión no se puede leer ni escribir nada, ni llamar
  a las RPC.
- `authenticated` puede leer, crear y editar `products`. **No hay política DELETE**: los
  productos solo se borran desde el dashboard.
- `authenticated` lee todos los `profiles`, para mostrar "quién lo hizo" en el historial y en
  la exportación. Los perfiles solo se crean con el trigger.
- `catalog_products` (catálogo TCG): `authenticated` solo puede **leer**. Únicamente el
  script de importación escribe, con la service_role key, que nunca está en el frontend.
- Las RPC son `SECURITY INVOKER` con `search_path` fijo, así que respetan RLS.
  **Riesgo aceptado para la Fase 1:** como el usuario necesita permiso de UPDATE en
  `products`, técnicamente podría cambiar `quantity` sin pasar por la RPC (sin movimiento).
  La app nunca lo hace. En la fase del POS conviene cerrarlo: quitar el UPDATE de
  `quantity` al rol y mover las RPC a `SECURITY DEFINER` con validación de rol.

### Imágenes (bucket privado)

- `product-images` es **privado**: solo usuarios autenticados suben y leen.
- `products.image_url` guarda la **ruta** del archivo (p. ej. `products/<uuid>.jpg`), no una
  URL, porque las URLs firmadas caducan. La app genera una URL firmada (1 h) cada vez que
  muestra una imagen.
- En la exportación, la columna "URL de imagen" trae una URL firmada que **vale 7 días**. Si
  algún día se necesitan links permanentes en el Excel, habría que hacer público el bucket
  (y aceptar que cualquiera con el link vea las fotos).
- Antes de subir, las imágenes se redimensionan en el navegador a un máximo de 800 px por
  lado y se comprimen a JPEG.

### Sin conexión (respaldo local)

- La app guarda en `localStorage` una copia del catálogo (código → nombre, cantidad…). Con
  eso sabe si un código existe aunque no haya red, y calcula los contadores.
- Si una operación falla por red, se guarda en una **cola** en `localStorage` y el
  encabezado muestra **"Sin conexión: N pendientes"**. Mientras haya pendientes, las nuevas
  operaciones también se encolan, para conservar el orden.
- Al volver la red (evento `online` o una prueba de conexión cada 15 s), la cola se
  sincroniza en orden, sola.
- Sin red **sí** se puede: escanear códigos conocidos, dar de alta productos nuevos (sin
  imagen) y deshacer.
- Sin red **no** se puede: generar códigos `HCH-` (la secuencia vive en la base de datos),
  subir imágenes ni exportar.
- Si la sesión expira sin red, la cola no se pierde. Al volver la red, la sesión se refresca
  sola; si no se puede, la app pide iniciar sesión y luego sincroniza.
- Si cierras sesión con pendientes, la app pide confirmación. La cola se queda en la
  computadora y se envía con el siguiente inicio de sesión.
- Si el servidor rechaza una operación de la cola (p. ej. un código que ya no existe), se
  aparta y se muestra en **Historial → Operaciones locales** para revisarla a mano.
- Pensado para **una sola computadora escaneando a la vez**. Con varias, "Fijar total"
  desde la cola podría pisar lo que otra sumó mientras tanto.

### Exportación

- **Exportar Excel (.xlsx)** es el formato recomendado para abrir en Excel: el código se
  guarda como **texto**, así que no se pierden ceros a la izquierda ni aparece notación
  científica (`7.50101E+12`).
- **Exportar CSV** va en UTF-8 con BOM (Excel respeta los acentos). Ojo: si abres el CSV con
  doble clic en Excel, **Excel convierte los códigos largos a número** y los daña. Usa el CSV
  para importar a otros sistemas, y el .xlsx para Excel.
- En **Historial** también se exportan los movimientos, con el usuario que hizo cada uno.

---

## Estructura

```
supabase/migrations/     Migraciones SQL (esquema, RLS, RPC, storage, catálogo TCG)
scripts/                 Importador del catálogo TCG (npm run catalogo) y administración
                         de clientes (npm run clientes)
.github/workflows/       Importación semanal del catálogo y actualización de clientes
src/
  lib/supabase.ts        Cliente único de Supabase + detección de errores de red/sesión
  auth/                  AuthProvider, useAuth, ProtectedRoute (listo para roles)
  store/                 Store de inventario: caché, cola offline, deshacer, sincronización
  pages/                 Login, Escaneo, Inventario, Mostrador, Ventas, Clientes, Historial, Etiqueta
  components/            Layout, formulario de producto, buscador del catálogo, webcam, imagen, foco
  lib/                   Exportación, imágenes, sonidos, normalización de códigos
netlify.toml             Build + redirección SPA
```

Pruebas manuales para el día del escaneo: [`docs/PRUEBAS_MANUALES.md`](docs/PRUEBAS_MANUALES.md).
