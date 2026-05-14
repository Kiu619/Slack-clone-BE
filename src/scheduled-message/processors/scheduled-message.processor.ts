import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { ScheduledMessageService } from '../scheduled-message.service'

@Processor('scheduled-messages')
export class ScheduledMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(ScheduledMessageProcessor.name)

  constructor(
    private readonly scheduledMessageService: ScheduledMessageService,
  ) {
    super()
  }

  async process(
    job: Job<{ scheduledMessageId: string }, void, string>,
  ): Promise<void> {
    if (job.name !== 'dispatch') {
      this.logger.warn(`Unknown job name: ${job.name}`)
      return
    }
    await this.scheduledMessageService.dispatch(job.data.scheduledMessageId)
  }
}
