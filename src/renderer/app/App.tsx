import { createHashRouter, Outlet, RouterProvider } from 'react-router'
import { HomePage } from '@/features/home/home-page'
import { LearnPage } from '@/features/learn/learn-page'
import { GlobalCommandAndSettings } from '@/features/navigation/command-palette'
import { PanelWindow } from '@/features/practice/panel-window'
import { ReportPrintPage } from '@/features/practice/report-print'
import { Workbench } from '@/features/practice/workbench'

function AppLayout() {
  return (
    <>
      <Outlet />
      <GlobalCommandAndSettings />
    </>
  )
}

// 桌面单页用 hash 路由，兼容 file:// 加载（PRD 14.2）。
// 根路径保留直达工作台以兼容 M0/SD-22 启动与性能基准用例；/home 为首页目录入口（顶栏返回与 Ctrl+K 可直达）。
const router = createHashRouter([
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <Workbench /> },
      { path: '/home', element: <HomePage /> },
      { path: '/learn', element: <LearnPage /> },
      { path: '/learn/:resourceId', element: <LearnPage /> },
      { path: '/practice/:projectId', element: <Workbench /> },
    ],
  },
  { path: '/panel/:panelId', element: <PanelWindow /> },
  { path: '/report-print/:jobId', element: <ReportPrintPage /> },
])

export function App() {
  return <RouterProvider router={router} />
}
