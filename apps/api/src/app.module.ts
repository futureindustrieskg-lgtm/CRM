import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AdminModule } from './admin/admin';
import { AuditModule } from './audit/audit';
import { AuthModule } from './auth/auth';
import { AuthGuard } from './common/auth.guard';
import { LeadsModule } from './leads/leads.module';
import { PrismaModule } from './prisma/prisma.service';
import { DocumentsModule } from './documents/documents.module';
import { ReportsModule } from './reports/reports.module';
import { FinanceModule } from './finance/finance.module';
import { HomeworkModule } from './homework/homework.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { NotificationsModule } from './notifications/notifications.module';
import { LearningModule } from './learning/learning.module';
import { ScheduleModule } from './schedule/schedule.module';
import { StudentsModule } from './students/students.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        secret: c.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: c.get<string>('JWT_ACCESS_TTL') ?? '15m' },
      }),
    }),
    PrismaModule,
    AuditModule,
    AuthModule,
    AdminModule,
    LeadsModule,
    StudentsModule,
    ScheduleModule,
    LearningModule,
    FinanceModule,
    HomeworkModule,
    NotificationsModule,
    DocumentsModule,
    ReportsModule,
    IntegrationsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
