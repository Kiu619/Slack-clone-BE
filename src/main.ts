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
