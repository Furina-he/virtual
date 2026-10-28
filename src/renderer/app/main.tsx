import { MotionConfig } from 'motion/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import '@/styles/globals.css'
import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 节点')

createRoot(root).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <App />
        <Toaster />
      </TooltipProvider>
    </MotionConfig>
  </StrictMode>,
)
