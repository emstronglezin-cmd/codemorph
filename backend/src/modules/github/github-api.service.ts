import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { UserEntity } from '../users/entities/user.entity';

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  htmlUrl: string;
  language: string | null;
  stargazersCount: number;
  defaultBranch: string;
  updatedAt: string;
}

export interface GitHubTreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
  url: string;
}

export interface RepoFile {
  path: string;
  content: string;
}

const GITHUB_API = 'https://api.github.com';
const MAX_FILE_SIZE = 500 * 1024; // 500KB per file
const IGNORED_PATHS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.dart_tool',
  '.pub-cache',
];
const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.dart', '.py', '.go',
  '.java', '.kt', '.swift', '.cs', '.rs', '.rb', '.php',
  '.json', '.yaml', '.yml', '.toml', '.env.example',
  '.html', '.css', '.scss', '.md',
];

@Injectable()
export class GitHubApiService {
  private readonly logger = new Logger(GitHubApiService.name);

  constructor(
    private readonly httpService: HttpService,
    _configService: ConfigService,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  private async getToken(userId: string): Promise<string> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'githubAccessToken'],
    });
    if (!user?.githubAccessToken) {
      throw new UnauthorizedException('No GitHub access token found. Please re-authenticate with GitHub.');
    }
    return user.githubAccessToken;
  }

  private headers(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async listUserRepos(userId: string, page = 1, perPage = 30): Promise<GitHubRepo[]> {
    const token = await this.getToken(userId);

    const response = await firstValueFrom(
      this.httpService.get(`${GITHUB_API}/user/repos`, {
        headers: this.headers(token),
        params: { page, per_page: perPage, sort: 'updated', type: 'all' },
      }),
    );

    return (response.data as Array<Record<string, unknown>>).map((r) => ({
      id: r['id'] as number,
      name: r['name'] as string,
      fullName: r['full_name'] as string,
      description: r['description'] as string | null,
      private: r['private'] as boolean,
      htmlUrl: r['html_url'] as string,
      language: r['language'] as string | null,
      stargazersCount: r['stargazers_count'] as number,
      defaultBranch: r['default_branch'] as string,
      updatedAt: r['updated_at'] as string,
    }));
  }

  async getRepoTree(userId: string, repo: string, branch: string): Promise<GitHubTreeItem[]> {
    const token = await this.getToken(userId);
    const [owner, name] = repo.split('/');

    const response = await firstValueFrom(
      this.httpService.get(
        `${GITHUB_API}/repos/${owner}/${name}/git/trees/${branch}?recursive=1`,
        { headers: this.headers(token) },
      ),
    );

    const tree = response.data['tree'] as GitHubTreeItem[];
    return tree.filter(
      (item) =>
        item.type === 'blob' &&
        !IGNORED_PATHS.some((p) => item.path.includes(p)) &&
        CODE_EXTENSIONS.some((ext) => item.path.endsWith(ext)) &&
        (item.size ?? 0) < MAX_FILE_SIZE,
    );
  }

  async fetchRepoFiles(repo: string, branch: string, userId: string): Promise<RepoFile[]> {
    const token = await this.getToken(userId);
    const [owner, name] = repo.split('/');

    this.logger.log(`Fetching files from ${repo}@${branch}`);

    const tree = await this.getRepoTree(userId, repo, branch);
    this.logger.log(`Found ${tree.length} files to fetch`);

    // Fetch in parallel batches of 10
    const BATCH_SIZE = 10;
    const files: RepoFile[] = [];

    for (let i = 0; i < tree.length; i += BATCH_SIZE) {
      const batch = tree.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const res = await firstValueFrom(
            this.httpService.get(
              `${GITHUB_API}/repos/${owner}/${name}/contents/${item.path}?ref=${branch}`,
              { headers: this.headers(token) },
            ),
          );
          const content = Buffer.from(res.data['content'] as string, 'base64').toString('utf-8');
          return { path: item.path, content };
        }),
      );

      for (const r of results) {
        if (r.status === 'fulfilled') files.push(r.value);
        else this.logger.warn(`Failed to fetch file: ${r.reason}`);
      }
    }

    this.logger.log(`Fetched ${files.length} files successfully`);
    return files;
  }

  async createPullRequest(
    userId: string,
    repo: string,
    branch: string,
    title: string,
    body: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<string> {
    const token = await this.getToken(userId);
    const [owner, name] = repo.split('/');

    // 1. Get default branch SHA
    const repoRes = await firstValueFrom(
      this.httpService.get(`${GITHUB_API}/repos/${owner}/${name}`, {
        headers: this.headers(token),
      }),
    );
    const defaultBranch = repoRes.data['default_branch'] as string;

    const refRes = await firstValueFrom(
      this.httpService.get(
        `${GITHUB_API}/repos/${owner}/${name}/git/refs/heads/${defaultBranch}`,
        { headers: this.headers(token) },
      ),
    );
    const baseSha = refRes.data['object']['sha'] as string;

    // 2. Create new branch
    await firstValueFrom(
      this.httpService.post(
        `${GITHUB_API}/repos/${owner}/${name}/git/refs`,
        { ref: `refs/heads/${branch}`, sha: baseSha },
        { headers: this.headers(token) },
      ),
    );

    // 3. Create blobs + tree
    const blobs = await Promise.all(
      files.map(async (f) => {
        const blobRes = await firstValueFrom(
          this.httpService.post(
            `${GITHUB_API}/repos/${owner}/${name}/git/blobs`,
            { content: f.content, encoding: 'utf-8' },
            { headers: this.headers(token) },
          ),
        );
        return { path: f.path, mode: '100644', type: 'blob', sha: blobRes.data['sha'] };
      }),
    );

    const treeRes = await firstValueFrom(
      this.httpService.post(
        `${GITHUB_API}/repos/${owner}/${name}/git/trees`,
        { base_tree: baseSha, tree: blobs },
        { headers: this.headers(token) },
      ),
    );

    // 4. Commit
    const commitRes = await firstValueFrom(
      this.httpService.post(
        `${GITHUB_API}/repos/${owner}/${name}/git/commits`,
        {
          message: title,
          tree: treeRes.data['sha'],
          parents: [baseSha],
        },
        { headers: this.headers(token) },
      ),
    );

    // 5. Update branch ref
    await firstValueFrom(
      this.httpService.patch(
        `${GITHUB_API}/repos/${owner}/${name}/git/refs/heads/${branch}`,
        { sha: commitRes.data['sha'] },
        { headers: this.headers(token) },
      ),
    );

    // 6. Create PR
    const prRes = await firstValueFrom(
      this.httpService.post(
        `${GITHUB_API}/repos/${owner}/${name}/pulls`,
        { title, body, head: branch, base: defaultBranch },
        { headers: this.headers(token) },
      ),
    );

    return prRes.data['html_url'] as string;
  }
}
