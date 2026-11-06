#!/bin/bash
# Corre las pruebas SQL en un Postgres LOCAL (nunca contra Supabase).
#   PGHOST=/tmp PGPORT=54329 supabase/tests/run.sh
# Crea la base "inventario_test" desde cero: stub de Supabase + todas las
# migraciones + pruebas.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PGUSER="${PGUSER:-postgres}"
DB=inventario_test
P="psql -v ON_ERROR_STOP=1 -q -X"

$P -d postgres -c "drop database if exists $DB" -c "create database $DB"
$P -d $DB -f supabase/tests/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do $P -d $DB -f "$f"; done
$P -d $DB -f supabase/tests/lotes_ubicaciones_test.sql

# Configuración del negocio: en su propia base recién creada (necesita que
# todavía no haya códigos internos para probar el cambio de prefijo).
$P -d postgres -c "drop database if exists ${DB}_config" -c "create database ${DB}_config"
$P -d ${DB}_config -f supabase/tests/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do $P -d ${DB}_config -f "$f"; done
$P -d ${DB}_config -f supabase/tests/configuracion_negocio_test.sql

# Productos sin inventario (comida, torneos): en su propia base.
$P -d postgres -c "drop database if exists ${DB}_sin" -c "create database ${DB}_sin"
$P -d ${DB}_sin -f supabase/tests/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do $P -d ${DB}_sin -f "$f"; done
$P -d ${DB}_sin -f supabase/tests/sin_inventario_test.sql

# Inventario inicial / Conteo y ajustes: en su propia base (cierra el
# inventario inicial).
$P -d postgres -c "drop database if exists ${DB}_conteo" -c "create database ${DB}_conteo"
$P -d ${DB}_conteo -f supabase/tests/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do $P -d ${DB}_conteo -f "$f"; done
$P -d ${DB}_conteo -f supabase/tests/conteo_inventario_inicial_test.sql

# Categorías configurables: una base que ya estaba en uso (productos y
# catálogo cargados) recibe la migración de categorías.
CAT=20261020000200
$P -d postgres -c "drop database if exists ${DB}_cat" -c "create database ${DB}_cat"
$P -d ${DB}_cat -f supabase/tests/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do [[ "$(basename "$f")" < "$CAT" ]] && $P -d ${DB}_cat -f "$f"; done
$P -d ${DB}_cat -f supabase/tests/categorias_antes.sql
for f in supabase/migrations/*.sql; do [[ "$(basename "$f")" < "$CAT" ]] || $P -d ${DB}_cat -f "$f"; done
$P -d ${DB}_cat -f supabase/tests/categorias_test.sql

# Idioma del producto: una base en uso (productos con "ESPAÑOL" en el nombre)
# recibe la migración del idioma.
LANG_MIG=20261102000100
$P -d postgres -c "drop database if exists ${DB}_lang" -c "create database ${DB}_lang"
$P -d ${DB}_lang -f supabase/tests/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do [[ "$(basename "$f")" < "$LANG_MIG" ]] && $P -d ${DB}_lang -f "$f"; done
$P -d ${DB}_lang -f supabase/tests/idioma_antes.sql
for f in supabase/migrations/*.sql; do [[ "$(basename "$f")" < "$LANG_MIG" ]] || $P -d ${DB}_lang -f "$f"; done
$P -d ${DB}_lang -f supabase/tests/idioma_test.sql

# Permisos: sin escrituras directas a ventas, créditos, puntos e historial.
$P -d postgres -c "drop database if exists ${DB}_perm" -c "create database ${DB}_perm"
$P -d ${DB}_perm -f supabase/tests/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do $P -d ${DB}_perm -f "$f"; done
$P -d ${DB}_perm -f supabase/tests/permisos_test.sql

# ---------- 10. Concurrencia ----------
# Dos ventas al mismo tiempo de un producto con 5 en tienda (3 + 3 piezas):
# solo una puede pasar. Y un traspaso tienda → bodega al mismo tiempo que una
# venta no pueden tomar las mismas piezas.
claims() { echo "select set_config('request.jwt.claims', '{\"sub\":\"$1\"}', false); set role authenticated;"; }
ADMIN=00000000-0000-0000-0000-00000000000a
MOSTRADOR=00000000-0000-0000-0000-00000000000b

$P -d $DB -c "$(claims $ADMIN) select public.create_product('CONC', 'Concurrente', 10, 1, null, null, 5);" >/dev/null

sale() { # ticket_id cantidad
  $P -d $DB -c "$(claims $MOSTRADOR) select pg_sleep(0.3); select public.pay_ticket('$1', null, 'cash', '[{\"barcode\":\"CONC\",\"quantity\":$2,\"unit_price\":10}]'::jsonb);" >/dev/null 2>&1 && echo ok || echo fail
}
transfer() { # id cantidad
  $P -d $DB -c "$(claims $ADMIN) select pg_sleep(0.3); select public.create_transfer('$1', 'store', 'warehouse', jsonb_build_array(jsonb_build_object('product_id', (select id from public.products where barcode = 'CONC'), 'quantity', $2)));" >/dev/null 2>&1 && echo ok || echo fail
}

r1=$(mktemp); r2=$(mktemp)
sale 50000000-0000-0000-0000-000000000001 3 >"$r1" &
sale 50000000-0000-0000-0000-000000000002 3 >"$r2" &
wait
res="$(cat "$r1" "$r2" | sort | tr '\n' ' ')"
[ "$res" = "fail ok " ] || { echo "FALLA 10a: dos ventas simultáneas → $res"; exit 1; }

# Quedan 2 en tienda: venta de 2 y traspaso de 2 a la vez → solo una pasa y
# la tienda queda en 0 (no en negativo)
sale 50000000-0000-0000-0000-000000000003 2 >"$r1" &
transfer 50000000-0000-0000-0000-000000000004 2 >"$r2" &
wait
res="$(cat "$r1" "$r2" | sort | tr '\n' ' ')"
[ "$res" = "fail ok " ] || { echo "FALLA 10b: venta + traspaso simultáneos → $res"; exit 1; }
rm -f "$r1" "$r2"

$P -d $DB -At -c "select case when (select quantity from public.products where barcode = 'CONC') = 0
                               and not exists (select 1 from public.stock_mismatches) then 'OK: concurrencia'
                          else 'FALLA 10: descuadre' end" | tee /dev/stderr | grep -q '^OK'
echo "OK: todo pasó"
