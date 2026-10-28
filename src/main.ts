import { NestFactory } from '@nestjs/core'
import * as cookieParser from 'cookie-parser'
import { AppModule } from './app.module.js'
import { NestExpressApplication } from '@nestjs/platform-express'
import type { Request, Response, NextFunction } from 'express'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  })

  app.use(cookieParser.default())

  // Authentication responses must never be revalidated from a browser cache.
  // Without this, GET /auth/me can return 304; Axios treats 304 as a rejected
  // response, which looks like an auth failure and can trigger redirect loops.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/auth' || req.path.startsWith('/auth/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
    }
    next()
  })

  const allowedOrigin = process.env.FRONTEND_URL || 'http://localhost:3045'
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isMutatingMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
      req.method,
    )
    if (!isMutatingMethod) {
      next()
      return
    }

    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== allowedOrigin) {
      res.status(403).json({ message: 'Invalid origin' })
      return
    }

    next()
  })

  app.enableCors({
    origin: allowedOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Socket-Id'],
  })

  app.useGlobalFilters(new AllExceptionsFilter())

  await app.listen(process.env.PORT ?? 8080)
}
bootstrap()
