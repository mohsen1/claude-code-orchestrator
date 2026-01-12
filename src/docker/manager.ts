import Docker from 'dockerode';
import { execa } from 'execa';
import { logger } from '../utils/logger.js';

export type ContainerStatus = 'running' | 'stopped' | 'unknown';

export class DockerManager {
  private docker: Docker;
  private containers: Map<string, Docker.Container> = new Map();

  constructor() {
    this.docker = new Docker();
  }

  async buildImage(dockerfilePath: string, imageName: string): Promise<void> {
    logger.info(`Building Docker image: ${imageName}`);

    // Resolve dockerfile path and verify it exists
    const { resolve, dirname } = await import('path');
    const { existsSync } = await import('fs');

    const absoluteDockerfilePath = resolve(process.cwd(), dockerfilePath);
    if (!existsSync(absoluteDockerfilePath)) {
      throw new Error(`Dockerfile not found at: ${absoluteDockerfilePath}`);
    }

    // Use the dockerfile's directory as the build context
    const buildContext = dirname(absoluteDockerfilePath);

    try {
      await execa('docker', ['build', '-t', imageName, '-f', absoluteDockerfilePath, buildContext], {
        cwd: process.cwd(),
        stdio: 'inherit',
      });
      logger.info(`Successfully built image: ${imageName}`);
    } catch (err) {
      logger.error(`Failed to build Docker image: ${imageName}`, err);
      throw err;
    }
  }

  async startContainers(composeFile: string): Promise<void> {
    logger.info(`Starting containers from: ${composeFile}`);

    try {
      await execa('docker-compose', ['-f', composeFile, 'up', '-d'], {
        stdio: 'inherit',
      });

      // Track containers
      await this.refreshContainerList();
      logger.info(`Started ${this.containers.size} containers`);
    } catch (err) {
      logger.error('Failed to start containers', err);
      throw err;
    }
  }

  async refreshContainerList(): Promise<void> {
    this.containers.clear();

    const containerInfos = await this.docker.listContainers({
      all: true,
      filters: { label: ['orchestrator.instance'] },
    });

    for (const info of containerInfos) {
      const container = this.docker.getContainer(info.Id);
      const name = info.Labels['orchestrator.instance'];
      if (name) {
        this.containers.set(name, container);
        logger.debug(`Tracking container: ${name} (${info.Id.substring(0, 12)})`);
      }
    }
  }

  async stopContainer(name: string): Promise<void> {
    const container = this.containers.get(name);
    if (container) {
      try {
        await container.stop({ t: 10 }); // 10 second timeout
        logger.info(`Stopped container: ${name}`);
      } catch (err: unknown) {
        if (err instanceof Error && !err.message.includes('container already stopped')) {
          throw err;
        }
      }
    } else {
      logger.warn(`Container not found: ${name}`);
    }
  }

  async restartContainer(name: string): Promise<void> {
    const container = this.containers.get(name);
    if (container) {
      await container.restart({ t: 10 });
      logger.info(`Restarted container: ${name}`);
    } else {
      logger.warn(`Container not found: ${name}`);
    }
  }

  async getContainerStatus(name: string): Promise<ContainerStatus> {
    const container = this.containers.get(name);
    if (!container) {
      return 'unknown';
    }

    try {
      const info = await container.inspect();
      return info.State.Running ? 'running' : 'stopped';
    } catch {
      return 'unknown';
    }
  }

  async execInContainer(name: string, command: string[]): Promise<string> {
    const container = this.containers.get(name);
    if (!container) {
      throw new Error(`Container ${name} not found`);
    }

    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise((resolve, reject) => {
      let output = '';

      stream.on('data', (chunk: Buffer) => {
        // Docker stream has 8-byte header per frame, skip it
        const data = chunk.slice(8).toString();
        output += data;
      });

      stream.on('end', () => resolve(output.trim()));
      stream.on('error', reject);
    });
  }

  async copyToContainer(containerName: string, srcPath: string, destPath: string): Promise<void> {
    await execa('docker', ['cp', srcPath, `${containerName}:${destPath}`]);
    logger.debug(`Copied ${srcPath} to ${containerName}:${destPath}`);
  }

  async stopAll(): Promise<void> {
    const names = Array.from(this.containers.keys());

    for (const name of names) {
      try {
        await this.stopContainer(name);
      } catch (err) {
        logger.warn(`Failed to stop container ${name}`, err);
      }
    }
  }

  async removeAll(): Promise<void> {
    for (const [name, container] of this.containers) {
      try {
        await container.remove({ force: true });
        logger.info(`Removed container: ${name}`);
      } catch (err) {
        logger.warn(`Failed to remove container ${name}`, err);
      }
    }
    this.containers.clear();
  }

  async cleanup(composeFile: string): Promise<void> {
    logger.info('Cleaning up Docker resources');

    try {
      await execa('docker-compose', ['-f', composeFile, 'down', '-v'], {
        stdio: 'inherit',
      });
    } catch (err) {
      logger.warn('Failed to run docker-compose down', err);
    }

    await this.removeAll();
  }

  getContainerNames(): string[] {
    return Array.from(this.containers.keys());
  }
}
