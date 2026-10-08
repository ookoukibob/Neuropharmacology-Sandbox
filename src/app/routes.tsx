import { Navigate, type RouteObject } from 'react-router-dom'
import { AppLayout } from './layout/AppLayout'
import { CalculatorPage } from './pages/CalculatorPage'
import { DrugDetailPage } from './pages/DrugDetailPage'
import { DrugLibraryPage } from './pages/DrugLibraryPage'
import { ImportExportPage } from './pages/ImportExportPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { SettingsPage } from './pages/SettingsPage'

/**
 * Central route table. Views live under src/app/pages; feature-specific UI
 * components are added under src/features/<feature>/ and mounted here.
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/library" replace /> },
      { path: 'library', element: <DrugLibraryPage /> },
      { path: 'library/:drugId', element: <DrugDetailPage /> },
      { path: 'calculator', element: <CalculatorPage /> },
      { path: 'import-export', element: <ImportExportPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]
