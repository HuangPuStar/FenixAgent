import type { AnyElysia, CreateEden } from "elysia";
import { ApplicationRuntime } from "./application-runtime";
import type { AnyServerModule } from "./server-module";

type ServerModuleWithFactory<TCreateRoutes extends () => AnyElysia> = Omit<AnyServerModule, "createRoutes"> & {
  readonly createRoutes: TCreateRoutes;
};

type ApplicationWithModule<TApp extends AnyElysia, TCreateRoutes extends () => AnyElysia> = TApp["~Prefix"] extends ""
  ? TApp & Pick<ReturnType<TCreateRoutes>, "~Routes">
  : TApp & {
      "~Routes": CreateEden<TApp["~Prefix"], ReturnType<TCreateRoutes>["~Routes"]>;
    };

/** ApplicationBuilder 初始配置。 */
export interface ApplicationBuilderOptions<TBaseApp extends AnyElysia> {
  readonly profileName: string;
  readonly createBaseApp: () => TBaseApp;
}

/** 通过 fluent ApplicationBuilder 声明模块顺序的代码级 Profile。 */
export interface ApplicationProfile<
  TBaseApp extends AnyElysia,
  TConfiguredBuilder extends ApplicationBuilder<AnyElysia, readonly AnyServerModule[], AnyElysia>,
> {
  readonly name: string;
  configure(builder: ApplicationBuilder<TBaseApp>): TConfiguredBuilder;
}

/** ApplicationProfile 定义无效。 */
export class ApplicationProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplicationProfileError";
  }
}

/** 通过逐次挂载 ServerModule 构造带生命周期的 Elysia 应用。 */
export class ApplicationBuilder<
  TBaseApp extends AnyElysia,
  TModules extends readonly AnyServerModule[] = readonly [],
  TApp extends AnyElysia = TBaseApp,
> {
  private constructor(
    private readonly profileName: string,
    private readonly createApp: () => AnyElysia,
    private readonly modules: TModules,
    private readonly moduleNames: ReadonlySet<string>,
  ) {}

  /** 创建尚未挂载业务模块的 ApplicationBuilder。 */
  static create<TBaseApp extends AnyElysia>(
    options: ApplicationBuilderOptions<TBaseApp>,
  ): ApplicationBuilder<TBaseApp> {
    if (!options.profileName.trim()) {
      throw new ApplicationProfileError("Application profile name must not be empty");
    }
    return new ApplicationBuilder(options.profileName, options.createBaseApp, [], new Set());
  }

  /** 按调用顺序挂载一个 ServerModule，并累积其路由类型。 */
  use<const TCreateRoutes extends () => AnyElysia>(module: ServerModuleWithFactory<TCreateRoutes>) {
    if (!module.name.trim()) throw new ApplicationProfileError("Server module name must not be empty");
    if (this.moduleNames.has(module.name)) {
      throw new ApplicationProfileError(`Duplicate server module name '${module.name}'`);
    }

    const createApp = () => this.createApp().use(module.createRoutes());
    const modules = [...this.modules, module] as unknown as readonly [
      ...TModules,
      ServerModuleWithFactory<TCreateRoutes>,
    ];
    const moduleNames = new Set(this.moduleNames);
    moduleNames.add(module.name);
    return new ApplicationBuilder<
      TBaseApp,
      readonly [...TModules, ServerModuleWithFactory<TCreateRoutes>],
      ApplicationWithModule<TApp, TCreateRoutes>
    >(this.profileName, createApp, modules, moduleNames);
  }

  /** 构造无启动副作用的 ApplicationRuntime。 */
  build() {
    // 相交实际 Elysia 实例可保留 Eden route 类型，同时避免再次展开大型 route tree。
    const app = this.createApp() as TApp;
    return new ApplicationRuntime(app, this.profileName, this.modules);
  }
}
