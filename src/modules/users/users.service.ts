import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { hashPassword, verifyPassword } from '../../common/password';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const PUBLIC_USER = { id: true, name: true, email: true, role: true, active: true, createdAt: true } satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.user.findMany({ select: PUBLIC_USER, orderBy: { name: 'asc' } });
  }

  async create(dto: CreateUserDto) {
    const email = dto.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('A user with this email already exists');
    }
    return this.prisma.user.create({
      data: { name: dto.name, email, role: dto.role, passwordHash: await hashPassword(dto.password) },
      select: PUBLIC_USER,
    });
  }

  async update(actor: AuthUser, id: string, dto: UpdateUserDto) {
    if (id === actor.id && (dto.active === false || (dto.role !== undefined && dto.role !== Role.ADMIN))) {
      throw new BadRequestException('You cannot deactivate or demote your own account');
    }
    if (!(await this.prisma.user.findUnique({ where: { id } }))) throw new NotFoundException('User not found');
    return this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name,
        role: dto.role,
        active: dto.active,
        ...(dto.password ? { passwordHash: await hashPassword(dto.password) } : {}),
      },
      select: PUBLIC_USER,
    });
  }

  async changeOwnPassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(dto.newPassword) } });
  }
}
