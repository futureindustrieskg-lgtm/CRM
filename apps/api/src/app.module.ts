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
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
