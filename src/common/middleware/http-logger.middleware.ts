import { Injectable, NestMiddleware, Logger } from '@nestjs/common'
import type { Request, Response, NextFunction } from 'express'

@Injectable()
export class HttpLoggerMiddleware implements NestMiddleware {
  private logger = new Logger('HTTP')

  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now()
    const { method, originalUrl } = req
    const cookieKeys = Object.keys(req.cookies ?? {}).join(',') || 'none'

    this.logger.log(`-> ${method} ${originalUrl} | cookies: ${cookieKeys}`)

    res.on('finish', () => {
      const duration = Date.now() - start
      const setCookies = res.getHeaders()['set-cookie']
      const setCookieNames = Array.isArray(setCookies)
        ? setCookies.map((c) => String(c).split('=')[0]).join(',')
        : ''
      const location = res.getHeaders()['location'] ?? ''
      this.logger.log(
        `<- ${method} ${originalUrl} ${res.statusCode} ${duration}ms | set-cookie: ${setCookieNames || 'none'} | location: ${location}`,
      )
    })

    next()
  }
}
