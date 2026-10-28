import { createHashRouter, RouterProvider } from 'react-router'
import { PanelWindow } from '@/features/practice/panel-window'
import { Workbench } from '@/features/practice/workbench'

// 桌面单页用 hash 路由，兼容 file:// 加载（PRD 14.2）。首页（PRD 15.3）未做前，根路径先进工作台
const router = createHashRouter([
  { path: '/', element: <Workbench /> },
  { path: '/practice/:projectId', element: <Workbench /> },
  { path: '/panel/:panelId', element: <PanelWindow /> },
])

export function App() {
  return <RouterProvider router={router} />
}
