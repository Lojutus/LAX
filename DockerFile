
FROM node:24-alpine

WORKDIR /app

# Instalar pnpm
RUN corepack enable

# Copiar archivos de dependencias
COPY package.json pnpm-lock.yaml ./

# Instalar dependencias
RUN pnpm install --frozen-lockfile

# Copiar el proyecto
COPY . .

# Mantener el contenedor disponible para desarrollo
CMD ["pnpm", "dev"]
