import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { ProtectedRoute } from './auth/ProtectedRoute'
import { Layout } from './components/Layout'
import { ConfigPage } from './pages/ConfigPage'
import { CustomerDetailPage } from './pages/CustomerDetailPage'
import { CustomersPage } from './pages/CustomersPage'
import { HistoryPage } from './pages/HistoryPage'
import { InventoryPage } from './pages/InventoryPage'
import { MostradorPage } from './pages/MostradorPage'
import { PurchasesPage } from './pages/PurchasesPage'
import { ReviewPricesPage } from './pages/ReviewPricesPage'
import { SinglesPage } from './pages/SinglesPage'
import { TransfersPage } from './pages/TransfersPage'
import { PreventasPage } from './pages/PreventasPage'
import { VentasPage } from './pages/VentasPage'
import { LabelPage } from './pages/LabelPage'
import { LoginPage } from './pages/LoginPage'
import { ScanPage } from './pages/ScanPage'
import { UsersPage } from './pages/UsersPage'

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/etiqueta/:code"
            element={
              <ProtectedRoute>
                <LabelPage />
              </ProtectedRoute>
            }
          />
          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            {/* La app abre en el Mostrador. */}
            <Route index element={<Navigate to="/mostrador" replace />} />
            <Route
              path="inventario-inicial"
              element={
                <ProtectedRoute roles={['admin']}>
                  <ScanPage variant="initial" />
                </ProtectedRoute>
              }
            />
            <Route
              path="conteo"
              element={
                <ProtectedRoute roles={['admin']}>
                  <ScanPage variant="count" />
                </ProtectedRoute>
              }
            />
            {/* "Agregar" se dividió en Inventario inicial, Compras y Conteo y ajustes. */}
            <Route path="agregar" element={<Navigate to="/conteo" replace />} />
            <Route path="inventario" element={<InventoryPage />} />
            <Route
              path="compras"
              element={
                <ProtectedRoute roles={['admin']}>
                  <PurchasesPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="singles"
              element={
                <ProtectedRoute roles={['admin']}>
                  <SinglesPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="revisar-precios"
              element={
                <ProtectedRoute roles={['admin']}>
                  <ReviewPricesPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="movimiento-bodega"
              element={
                <ProtectedRoute roles={['admin']}>
                  <TransfersPage />
                </ProtectedRoute>
              }
            />
            <Route path="mostrador" element={<MostradorPage />} />
            <Route path="ventas" element={<VentasPage />} />
            <Route path="preventas" element={<PreventasPage />} />
            <Route path="clientes" element={<CustomersPage />} />
            <Route path="clientes/:id" element={<CustomerDetailPage />} />
            <Route path="historial" element={<HistoryPage />} />
            <Route
              path="configuracion"
              element={
                <ProtectedRoute roles={['admin']}>
                  <ConfigPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="usuarios"
              element={
                <ProtectedRoute roles={['admin']}>
                  <UsersPage />
                </ProtectedRoute>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
