import type { Evt } from 'evt'
import {
  ioSchema,
  T_IO_DISPLAY_METHOD_NAMES,
  T_IO_INPUT_METHOD_NAMES,
  T_IO_METHOD_NAMES,
  T_IO_MULTIPLEABLE_METHOD_NAMES,
  T_IO_PROPS,
  T_IO_RETURNS,
  T_IO_STATE,
} from '../ioSchema'
import IOComponent, {
  AnyIOComponent,
  ComponentReturnValue,
  MaybeMultipleComponentReturnValue,
} from './IOComponent'
import IOError from './IOError'
import {
  ComponentRenderer,
  ComponentsRenderer,
  GroupIOPromise,
  MaybeOptionalGroupIOPromise,
  OptionalGroupIOPromise,
  ButtonConfig,
  ChoiceButtonConfig,
  ChoiceButtonConfigOrShorthand,
  ComponentsRendererReturn,
} from '../types'
import { IOClientRenderReturnValues } from './IOClient'
import { z, ZodError } from 'zod'
import UtilHQError from './UtilHQError'

interface IOPromiseProps<
  MethodName extends T_IO_METHOD_NAMES,
  Props extends T_IO_PROPS<MethodName> = T_IO_PROPS<MethodName>,
  ComponentOutput = ComponentReturnValue<MethodName>
> {
  renderer: ComponentRenderer<MethodName>
  methodName: MethodName
  label: string
  props: Props
  onPropsUpdate?: Evt<T_IO_PROPS<MethodName>>
  valueGetter?: (response: ComponentReturnValue<MethodName>) => ComponentOutput
  onStateChange?: (
    incomingState: T_IO_STATE<MethodName>
  ) => Promise<Partial<Props>>
  validator?: IOPromiseValidator<ComponentOutput> | undefined
  displayResolvesImmediately?: boolean
}

/**
 * A custom wrapper class that handles creating the underlying component
 * model when the IO call is to be rendered, and optionally transforming
 * the value received from utilhq to a custom component return type.
 *
 * Can be `await`ed, which renders its own component by itself,
 * or rendered as a group along with other IOPromises.
 */
export class IOPromise<
  MethodName extends T_IO_METHOD_NAMES,
  Props extends T_IO_PROPS<MethodName> = T_IO_PROPS<MethodName>,
  ComponentOutput = ComponentReturnValue<MethodName>
> {
  /* @internal */ methodName: MethodName
  /* @internal */ renderer: ComponentRenderer<MethodName>
  protected label: string
  protected props: Props
  protected valueGetter:
    | ((response: ComponentReturnValue<MethodName>) => ComponentOutput)
    | undefined
  protected onStateChange:
    | ((incomingState: T_IO_STATE<MethodName>) => Promise<Partial<Props>>)
    | undefined
  /* @internal */ validator: IOPromiseValidator<ComponentOutput> | undefined
  protected displayResolvesImmediately: boolean | undefined
  protected onPropsUpdate: Evt<T_IO_PROPS<MethodName>> | undefined

  constructor({
    renderer,
    methodName,
    label,
    props,
    valueGetter,
    onStateChange,
    validator,
    displayResolvesImmediately,
    onPropsUpdate,
  }: IOPromiseProps<MethodName, Props, ComponentOutput>) {
    this.renderer = renderer
    this.methodName = methodName
    this.label = label
    this.props = props
    this.valueGetter = valueGetter
    this.onStateChange = onStateChange
    this.validator = validator
    this.displayResolvesImmediately = displayResolvesImmediately
    this.onPropsUpdate = onPropsUpdate
  }

  then(
    resolve: (output: ComponentOutput) => void,
    reject?: (err: IOError) => void
  ) {
    this.renderer({ components: [this.component] })
      .then(({ returnValue: [result] }) => {
        const parsed = ioSchema[this.methodName].returns.parse(result)
        resolve(this.getValue(parsed))
      })
      .catch(err => {
        if (reject) {
          if (err instanceof ZodError) {
            // This should be caught already, primarily here for types
            reject(
              new IOError('BAD_RESPONSE', 'Received invalid response.', {
                cause: err,
              })
            )
          } else {
            reject(err)
          }
        }
      })
  }

  getValue(result: ComponentReturnValue<MethodName>): ComponentOutput {
    if (this.valueGetter) return this.valueGetter(result)

    return result as unknown as ComponentOutput
  }

  get component() {
    return new IOComponent({
      methodName: this.methodName,
      label: this.label,
      initialProps: this.props,
      onStateChange: this.onStateChange,
      displayResolvesImmediately: this.displayResolvesImmediately,
      onPropsUpdate: this.onPropsUpdate,
    })
  }
}

/**
 * A thin subtype of IOPromise that does nothing but mark the component
 * as "display" for display-only components.
 */
export class DisplayIOPromise<
  MethodName extends T_IO_DISPLAY_METHOD_NAMES,
  Props extends T_IO_PROPS<MethodName> = T_IO_PROPS<MethodName>,
  ComponentOutput = ComponentReturnValue<MethodName>
> extends IOPromise<MethodName, Props, ComponentOutput> {
  withChoices<Choice extends string>(
    choiceButtons: ChoiceButtonConfigOrShorthand<Choice>[]
  ): WithChoicesIOPromise<
    MethodName,
    Props,
    ComponentOutput,
    DisplayIOPromise<MethodName, Props, ComponentOutput>,
    Choice
  > {
    return new WithChoicesIOPromise({
      innerPromise: this,
      choiceButtons,
    })
  }
}

export class InputIOPromise<
  MethodName extends T_IO_INPUT_METHOD_NAMES,
  Props extends T_IO_PROPS<MethodName> = T_IO_PROPS<MethodName>,
  ComponentOutput = ComponentReturnValue<MethodName>
> extends IOPromise<MethodName, Props, ComponentOutput> {
  get component() {
    return new IOComponent({
      methodName: this.methodName,
      label: this.label,
      initialProps: this.props,
      onStateChange: this.onStateChange,
      validator: this.validator ? this.handleValidation.bind(this) : undefined,
      displayResolvesImmediately: this.displayResolvesImmediately,
      onPropsUpdate: this.onPropsUpdate,
    })
  }

  /* @internal */ async handleValidation(
    returnValue: MaybeMultipleComponentReturnValue<MethodName> | undefined
  ): Promise<string | undefined> {
    // These should be caught already, primarily here for types
    if (returnValue === undefined) {
      return 'This field is required.'
    }

    const parsed = ioSchema[this.methodName].returns.safeParse(returnValue)
    if (parsed.success) {
      if (this.validator) {
        return this.validator(this.getValue(parsed.data))
      }
    } else {
      // shouldn't be hit, but just in case
      return 'Received invalid value for field.'
    }
  }

  validate(validator: IOPromiseValidator<ComponentOutput>): this {
    this.validator = validator

    return this
  }

  optional(
    isOptional?: true
  ): OptionalIOPromise<MethodName, Props, ComponentOutput>
  optional(
    isOptional?: false
  ): InputIOPromise<MethodName, Props, ComponentOutput>
  optional(
    isOptional?: boolean
  ):
    | OptionalIOPromise<MethodName, Props, ComponentOutput>
    | InputIOPromise<MethodName, Props, ComponentOutput>
  optional(
    isOptional = true
  ):
    | OptionalIOPromise<MethodName, Props, ComponentOutput>
    | InputIOPromise<MethodName, Props, ComponentOutput> {
    return isOptional
      ? new OptionalIOPromise({
          renderer: this.renderer,
          methodName: this.methodName,
          label: this.label,
          props: this.props,
          valueGetter: this.valueGetter,
          onStateChange: this.onStateChange,
        })
      : this
  }

  withChoices<Choice extends string>(
    choiceButtons: ChoiceButtonConfigOrShorthand<Choice>[]
  ): WithChoicesIOPromise<
    MethodName,
    Props,
    ComponentOutput,
    InputIOPromise<MethodName, Props, ComponentOutput>,
    Choice
  > {
    return new WithChoicesIOPromise({
      innerPromise: this,
      choiceButtons,
    })
  }
}

/**
 * A thin subclass of IOPromise that marks its inner component as
 * "optional" and returns `undefined` if not provided by the action runner.
 */
export class OptionalIOPromise<
  MethodName extends T_IO_INPUT_METHOD_NAMES,
  Props extends T_IO_PROPS<MethodName> = T_IO_PROPS<MethodName>,
  ComponentOutput = ComponentReturnValue<MethodName>
> extends InputIOPromise<MethodName, Props, ComponentOutput | undefined> {
  then(
    resolve: (output: ComponentOutput | undefined) => void,
    reject?: (err: IOError) => void
  ) {
    this.renderer({ components: [this.component] })
      .then(({ returnValue: [result] }) => {
        const parsed = ioSchema[this.methodName].returns
          .optional()
          .parse(result)
        resolve(this.getValue(parsed))
      })
      .catch(err => {
        if (reject) {
          if (err instanceof ZodError) {
            // This should be caught already, primarily here for types
            reject(
              new IOError('BAD_RESPONSE', 'Received invalid response.', {
                cause: err,
              })
            )
          } else {
            reject(err)
          }
        }
      })
  }

  get component() {
    return new IOComponent({
      methodName: this.methodName,
      label: this.label,
      initialProps: this.props,
      onStateChange: this.onStateChange,
      isOptional: true,
      validator: this.validator ? this.handleValidation.bind(this) : undefined,
      displayResolvesImmediately: this.displayResolvesImmediately,
      onPropsUpdate: this.onPropsUpdate,
    })
  }

  /* @internal */ async handleValidation(
    returnValue: MaybeMultipleComponentReturnValue<MethodName> | undefined
  ): Promise<string | undefined> {
    // These should be caught already, primarily here for types
    const parsed = ioSchema[this.methodName].returns
      .optional()
      .safeParse(returnValue)
    if (parsed.success) {
      if (this.validator) {
        return this.validator(this.getValue(parsed.data))
      }
    } else {
      // shouldn't be hit, but just in case
      return 'Received invalid value for field.'
    }
  }

  getValue(
    result: ComponentReturnValue<MethodName> | undefined
  ): ComponentOutput | undefined {
    if (result === undefined) return undefined

    if (this.valueGetter) {
      return this.valueGetter(result)
    }

    return result as unknown as ComponentOutput
  }
}

export class MultipleableIOPromise<
  MethodName extends T_IO_MULTIPLEABLE_METHOD_NAMES,
  Props extends T_IO_PROPS<MethodName> = T_IO_PROPS<MethodName>,
  ComponentOutput = ComponentReturnValue<MethodName>,
  DefaultValue = T_IO_PROPS<MethodName> extends { defaultValue?: any }
    ? ComponentOutput | null
    : never
> extends InputIOPromise<MethodName, Props, ComponentOutput> {
  defaultValueGetter:
    | ((defaultValue: DefaultValue) => T_IO_RETURNS<MethodName>)
    | undefined

  constructor({
    defaultValueGetter,
    ...props
  }: {
    renderer: ComponentRenderer<MethodName>
    methodName: MethodName
    label: string
    props: Props
    valueGetter?: (
      response: ComponentReturnValue<MethodName>
    ) => ComponentOutput
    defaultValueGetter?: (
      defaultValue: DefaultValue
    ) => T_IO_RETURNS<MethodName>
    onStateChange?: (
      incomingState: T_IO_STATE<MethodName>
    ) => Promise<Partial<Props>>
    validator?: IOPromiseValidator<ComponentOutput> | undefined
    displayResolvesImmediately?: boolean
    onPropsUpdate?: Evt<T_IO_PROPS<MethodName>>
  }) {
    super(props)
    this.defaultValueGetter = defaultValueGetter
  }

  multiple({
    defaultValue,
  }: {
    defaultValue?: DefaultValue[] | null
  } = {}): MultipleIOPromise<MethodName, Props, ComponentOutput> {
    let transformedDefaultValue: T_IO_RETURNS<MethodName>[] | undefined | null
    const propsSchema = ioSchema[this.methodName].props
    if (defaultValue && 'defaultValue' in propsSchema.shape) {
      const { defaultValueGetter } = this
      const potentialDefaultValue = defaultValueGetter
        ? defaultValue.map(dv => defaultValueGetter(dv))
        : (defaultValue as unknown as T_IO_RETURNS<MethodName>[])

      try {
        const defaultValueSchema = propsSchema.shape.defaultValue
        transformedDefaultValue = z
          .array(defaultValueSchema.unwrap().unwrap())
          .parse(potentialDefaultValue)
      } catch (err) {
        console.error(
          `[utilhq] Invalid default value found for multiple IO call with label "${this.label}": ${defaultValue}. This default value will be ignored.`
        )
        console.error(err)
        transformedDefaultValue = undefined
      }
    }

    return new MultipleIOPromise<MethodName, Props, ComponentOutput>({
      renderer: this.renderer,
      methodName: this.methodName,
      label: this.label,
      props: this.props,
      valueGetter: this.valueGetter,
      onStateChange: this.onStateChange,
      defaultValue: transformedDefaultValue,
    })
  }

  withChoices<Choice extends string>(
    choiceButtons: ChoiceButtonConfigOrShorthand<Choice>[]
  ): WithChoicesIOPromise<
    MethodName,
    Props,
    ComponentOutput,
    MultipleableIOPromise<MethodName, Props, ComponentOutput, DefaultValue>,
    Choice
  > {
    return new WithChoicesIOPromise({
      innerPromise: this,
      choiceButtons,
    })
  }
}

export class MultipleIOPromise<
  MethodName extends T_IO_MULTIPLEABLE_METHOD_NAMES,
  Props extends T_IO_PROPS<MethodName> = T_IO_PROPS<MethodName>,
  ComponentOutput = ComponentReturnValue<MethodName>
> extends InputIOPromise<MethodName, Props, ComponentOutput[]> {
  getSingleValue:
    | ((response: ComponentReturnValue<MethodName>) => ComponentOutput)
    | undefined
  defaultValue: T_IO_RETURNS<MethodName>[] | undefined | null

  constructor({
    defaultValue,
    valueGetter,
    ...rest
  }: {
    defaultValue?: T_IO_RETURNS<MethodName>[] | null
    renderer: ComponentRenderer<MethodName>
    methodName: MethodName
    label: string
    props: Props
    valueGetter?: (
      response: ComponentReturnValue<MethodName>
    ) => ComponentOutput
    onStateChange?: (
      incomingState: T_IO_STATE<MethodName>
    ) => Promise<Partial<Props>>
    validator?: IOPromiseValidator<ComponentOutput[]> | undefined
    onPropsUpdate?: Evt<T_IO_PROPS<MethodName>>
  }) {
    super(rest)
    this.getSingleValue = valueGetter
    this.defaultValue = defaultValue
  }

  then(
    resolve: (output: ComponentOutput[]) => void,
    reject?: (err: IOError) => void
  ) {
    this.renderer({ components: [this.component] })
      .then(({ returnValue: [results] }) => {
        resolve(this.getValue(results))
      })
      .catch(err => {
        if (reject) reject(err)
      })
  }

  validate(validator: IOPromiseValidator<ComponentOutput[]>): this {
    this.validator = validator

    return this
  }

  getValue(
    results: MaybeMultipleComponentReturnValue<MethodName>
  ): ComponentOutput[] {
    if (!Array.isArray(results)) {
      results = [results]
    }

    const { getSingleValue } = this
    if (getSingleValue) {
      return results.map(result => getSingleValue(result))
    }

    return results as unknown as ComponentOutput[]
  }

  /* @internal */ async handleValidation(
    returnValues: MaybeMultipleComponentReturnValue<MethodName> | undefined
  ): Promise<string | undefined> {
    // These should be caught already, primarily here for types
    if (!returnValues) {
      return 'This field is required.'
    }

    const parsed = z
      .array(ioSchema[this.methodName].returns)
      .safeParse(returnValues)
    if (parsed.success) {
      if (this.validator) {
        return this.validator(this.getValue(parsed.data))
      }
    } else {
      // shouldn't be hit, but just in case
      return 'Received invalid value for field.'
    }
  }

  get component() {
    return new IOComponent({
      methodName: this.methodName,
      label: this.label,
      initialProps: this.props,
      onStateChange: this.onStateChange,
      validator: this.validator ? this.handleValidation.bind(this) : undefined,
      isMultiple: true,
      multipleProps: {
        defaultValue: this.defaultValue,
      },
      displayResolvesImmediately: this.displayResolvesImmediately,
      onPropsUpdate: this.onPropsUpdate,
    })
  }

  optional(
    isOptional?: true
  ): OptionalMultipleIOPromise<MethodName, Props, ComponentOutput>
  optional(
    isOptional?: false
  ): MultipleIOPromise<MethodName, Props, ComponentOutput>
  optional(
    isOptional?: boolean
  ):
    | OptionalMultipleIOPromise<MethodName, Props, ComponentOutput>
    | MultipleIOPromise<MethodName, Props, ComponentOutput>
  optional(
    isOptional = true
  ):
    | OptionalMultipleIOPromise<MethodName, Props, ComponentOutput>
    | MultipleIOPromise<MethodName, Props, ComponentOutput> {
    return isOptional
      ? new OptionalMultipleIOPromise<MethodName, Props, ComponentOutput>({
          renderer: this.renderer,
          methodName: this.methodName,
          label: this.label,
          props: this.props,
          valueGetter: this.getSingleValue,
          defaultValue: this.defaultValue,
          onStateChange: this.onStateChange,
        })
      : this
  }
}

export class OptionalMultipleIOPromise<
  MethodName extends T_IO_MULTIPLEABLE_METHOD_NAMES,
  Props extends T_IO_PROPS<MethodName> = T_IO_PROPS<MethodName>,
  ComponentOutput = ComponentReturnValue<MethodName>
> extends OptionalIOPromise<MethodName, Props, ComponentOutput[]> {
  getSingleValue:
    | ((response: ComponentReturnValue<MethodName>) => ComponentOutput)
    | undefined
  defaultValue: T_IO_RETURNS<MethodName>[] | undefined | null

  constructor({
    defaultValue,
    valueGetter,
    ...rest
  }: {
    defaultValue?: T_IO_RETURNS<MethodName>[] | null
    renderer: ComponentRenderer<MethodName>
    methodName: MethodName
    label: string
    props: Props
    valueGetter?: (
      response: ComponentReturnValue<MethodName>
    ) => ComponentOutput
    onStateChange?: (
      incomingState: T_IO_STATE<MethodName>
    ) => Promise<Partial<Props>>
    validator?: IOPromiseValidator<ComponentOutput[] | undefined> | undefined
    onPropsUpdate?: Evt<T_IO_PROPS<MethodName>>
  }) {
    super(rest)
    this.getSingleValue = valueGetter
    this.defaultValue = defaultValue
  }

  then(
    resolve: (output: ComponentOutput[] | undefined) => void,
    reject?: (err: IOError) => void
  ) {
    this.renderer({ components: [this.component] })
      .then(({ returnValue: [results] }) => {
        resolve(this.getValue(results))
      })
      .catch(err => {
        if (reject) reject(err)
      })
  }

  validate(validator: IOPromiseValidator<ComponentOutput[] | undefined>): this {
    this.validator = validator

    return this
  }

  getValue(
    results: MaybeMultipleComponentReturnValue<MethodName> | undefined
  ): ComponentOutput[] | undefined {
    if (!results) return undefined

    if (!Array.isArray(results)) {
      results = [results]
    }

    const { getSingleValue } = this
    if (getSingleValue) {
      return results.map(result => getSingleValue(result))
    }

    return results as unknown as ComponentOutput[]
  }

  /* @internal */ async handleValidation(
    returnValues: MaybeMultipleComponentReturnValue<MethodName> | undefined
  ): Promise<string | undefined> {
    // These should be caught already, primarily here for types
    const parsed = z
      .array(ioSchema[this.methodName].returns)
      .optional()
      .safeParse(returnValues)
    if (parsed.success) {
      if (this.validator) {
        return this.validator(this.getValue(parsed.data))
      }
    } else {
      // shouldn't be hit, but just in case
      return 'Received invalid value for field.'
    }
  }

  get component() {
    return new IOComponent({
      methodName: this.methodName,
      label: this.label,
      initialProps: this.props,
      onStateChange: this.onStateChange,
      validator: this.validator ? this.handleValidation.bind(this) : undefined,
      isMultiple: true,
      isOptional: true,
      multipleProps: {
        defaultValue: this.defaultValue,
      },
      displayResolvesImmediately: this.displayResolvesImmediately,
      onPropsUpdate: this.onPropsUpdate,
    })
  }
}

export class WithChoicesIOPromise<
  MethodName extends T_IO_METHOD_NAMES,
  Props extends T_IO_PROPS<MethodName> = T_IO_PROPS<MethodName>,
  ComponentOutput = ComponentReturnValue<MethodName>,
  InnerPromise extends IOPromise<
    MethodName,
    Props,
    ComponentOutput
  > = IOPromise<MethodName, Props, ComponentOutput>,
  Choice extends string = string
> {
  innerPromise: InnerPromise
  choiceButtons: ChoiceButtonConfig[]
  #validator: WithChoicesIOPromiseValidator<Choice, ComponentOutput> | undefined

  constructor({
    innerPromise,
    choiceButtons,
  }: {
    innerPromise: InnerPromise
    choiceButtons: ChoiceButtonConfigOrShorthand<Choice>[]
  }) {
    this.innerPromise = innerPromise
    this.choiceButtons = choiceButtons.map(b =>
      typeof b === 'string'
        ? { label: b as string, value: b as string }
        : (b as ChoiceButtonConfig)
    )
  }

  then(
    resolve: (output: { choice: Choice; returnValue: ComponentOutput }) => void,
    reject?: (err: IOError) => void
  ) {
    this.innerPromise
      .renderer({
        components: [this.component],
        choiceButtons: this.choiceButtons,
        validator: this.#validator
          ? this.handleValidation.bind(this)
          : undefined,
      })
      .then(({ returnValue: [result], choice }) => {
        const methodName = this.innerPromise.methodName
        const parsed =
          this.innerPromise instanceof MultipleIOPromise ||
          this.innerPromise instanceof OptionalMultipleIOPromise
            ? result
            : this.innerPromise instanceof OptionalIOPromise
            ? ioSchema[methodName].returns.optional().parse(result)
            : ioSchema[methodName].returns.parse(result)

        // Need a cast here because can't really prove statically, the checks above should be correct though
        resolve({
          choice: choice as Choice,
          returnValue: this.getValue(
            parsed as ComponentReturnValue<MethodName>
          ),
        })
      })
      .catch(err => {
        if (reject) {
          if (err instanceof ZodError) {
            // This should be caught already, primarily here for types
            reject(
              new IOError('BAD_RESPONSE', 'Received invalid response.', {
                cause: err,
              })
            )
          } else {
            reject(err)
          }
        }
      })
  }

  get getValue() {
    return this.innerPromise.getValue.bind(this.innerPromise)
  }

  get component() {
    return this.innerPromise.component
  }

  validate(
    validator: WithChoicesIOPromiseValidator<Choice, ComponentOutput>
  ): this {
    this.innerPromise.validator = undefined

    this.#validator = validator

    return this
  }

  /* @internal */ async handleValidation(
    returnValues: IOClientRenderReturnValues<
      [AnyIOComponent, ...AnyIOComponent[]]
    >
  ): Promise<string | undefined> {
    if (!this.#validator) return

    this.innerPromise.validator = undefined

    // Perform basic type validation, for extra safety
    if (
      this.innerPromise instanceof InputIOPromise ||
      this.innerPromise instanceof OptionalIOPromise ||
      this.innerPromise instanceof MultipleIOPromise ||
      this.innerPromise instanceof OptionalMultipleIOPromise
    ) {
      const innerValidation = await this.innerPromise.handleValidation(
        returnValues.returnValue[0]
      )

      if (innerValidation != null) {
        return innerValidation
      }
    }

    return this.#validator({
      choice: returnValues.choice as Choice,
      returnValue: returnValues.returnValue[0] as ComponentOutput,
    })
  }

  // These overrides are pretty disgusting but are unavoidable I think
  optional<
    MethodName extends T_IO_INPUT_METHOD_NAMES,
    Props extends T_IO_PROPS<MethodName>,
    ComponentOutput = ComponentReturnValue<MethodName>
  >(
    this: WithChoicesIOPromise<
      MethodName,
      Props,
      ComponentOutput,
      InputIOPromise<MethodName, Props, ComponentOutput>,
      Choice
    >,
    isOptional?: true
  ): WithChoicesIOPromise<
    MethodName,
    Props,
    ComponentOutput | undefined,
    OptionalIOPromise<MethodName, Props, ComponentOutput>,
    Choice
  >
  optional<
    MethodName extends T_IO_INPUT_METHOD_NAMES,
    Props extends T_IO_PROPS<MethodName>,
    ComponentOutput = ComponentReturnValue<MethodName>
  >(
    this: WithChoicesIOPromise<
      MethodName,
      Props,
      ComponentOutput,
      InputIOPromise<MethodName, Props, ComponentOutput>,
      Choice
    >,
    isOptional?: false
  ): WithChoicesIOPromise<
    MethodName,
    Props,
    ComponentOutput,
    InputIOPromise<MethodName, Props, ComponentOutput>,
    Choice
  >
  optional<
    MethodName extends T_IO_INPUT_METHOD_NAMES,
    Props extends T_IO_PROPS<MethodName>,
    ComponentOutput = ComponentReturnValue<MethodName>
  >(
    this: WithChoicesIOPromise<
      MethodName,
      Props,
      ComponentOutput,
      InputIOPromise<MethodName, Props, ComponentOutput>,
      Choice
    >,
    isOptional?: boolean
  ):
    | WithChoicesIOPromise<
        MethodName,
        Props,
        ComponentOutput | undefined,
        OptionalIOPromise<MethodName, Props, ComponentOutput>,
        Choice
      >
    | WithChoicesIOPromise<
        MethodName,
        Props,
        ComponentOutput,
        InputIOPromise<MethodName, Props, ComponentOutput>,
        Choice
      >
  optional<
    MethodName extends T_IO_MULTIPLEABLE_METHOD_NAMES,
    Props extends T_IO_PROPS<MethodName>,
    ComponentOutput = ComponentReturnValue<MethodName>
  >(
    this: WithChoicesIOPromise<
      MethodName,
      Props,
      ComponentOutput[],
      MultipleIOPromise<MethodName, Props, ComponentOutput>,
      Choice
    >,
    isOptional?: true
  ): WithChoicesIOPromise<
    MethodName,
    Props,
    ComponentOutput[] | undefined,
    OptionalMultipleIOPromise<MethodName, Props, ComponentOutput>,
    Choice
  >
  optional<
    MethodName extends T_IO_MULTIPLEABLE_METHOD_NAMES,
    Props extends T_IO_PROPS<MethodName>,
    ComponentOutput = ComponentReturnValue<MethodName>
  >(
    this: WithChoicesIOPromise<
      MethodName,
      Props,
      ComponentOutput[],
      MultipleIOPromise<MethodName, Props, ComponentOutput>,
      Choice
    >,
    isOptional?: false
  ): WithChoicesIOPromise<
    MethodName,
    Props,
    ComponentOutput[],
    MultipleIOPromise<MethodName, Props, ComponentOutput>,
    Choice
  >
  optional<
    MethodName extends T_IO_MULTIPLEABLE_METHOD_NAMES,
    Props extends T_IO_PROPS<MethodName>,
    ComponentOutput = ComponentReturnValue<MethodName>
  >(
    this: WithChoicesIOPromise<
      MethodName,
      Props,
      ComponentOutput[],
      MultipleIOPromise<MethodName, Props, ComponentOutput>,
      Choice
    >,
    isOptional?: boolean
  ):
    | WithChoicesIOPromise<
        MethodName,
        Props,
        ComponentOutput[] | undefined,
        OptionalMultipleIOPromise<MethodName, Props, ComponentOutput>,
        Choice
      >
    | WithChoicesIOPromise<
        MethodName,
        Props,
        ComponentOutput[],
        MultipleIOPromise<MethodName, Props, ComponentOutput>,
        Choice
      >
  optional<
    MethodName extends T_IO_INPUT_METHOD_NAMES,
    Props extends T_IO_PROPS<MethodName>,
    ComponentOutput = ComponentReturnValue<MethodName>
  >(
    this: WithChoicesIOPromise<
      MethodName,
      Props,
      ComponentOutput,
      InputIOPromise<MethodName, Props, ComponentOutput>,
      Choice
    >,
    isOptional = true
  ):
    | WithChoicesIOPromise<
        MethodName,
        Props,
        ComponentOutput | undefined,
        OptionalIOPromise<MethodName, Props, ComponentOutput>,
        Choice
      >
    | WithChoicesIOPromise<
        MethodName,
        Props,
        ComponentOutput,
        InputIOPromise<MethodName, Props, ComponentOutput>,
        Choice
      > {
    if (!(this.innerPromise instanceof InputIOPromise)) {
      throw new UtilHQError(
        `Invalid chained method call: only input IO methods can be marked as .optional(). Invalid call on the method with label "${this.component.label}".`
      )
    }

    return isOptional
      ? new WithChoicesIOPromise<
          MethodName,
          Props,
          ComponentOutput | undefined,
          OptionalIOPromise<MethodName, Props, ComponentOutput>,
          Choice
        >({
          innerPromise: this.innerPromise.optional(isOptional),
          choiceButtons: this.choiceButtons as (ChoiceButtonConfig & {
            value: Choice
          })[],
        })
      : this
  }

  multiple<
    MethodName extends T_IO_MULTIPLEABLE_METHOD_NAMES,
    Props extends T_IO_PROPS<MethodName>,
    ComponentOutput = ComponentReturnValue<MethodName>,
    DefaultValue = T_IO_PROPS<MethodName> extends { defaultValue?: any }
      ? ComponentOutput | null
      : never
  >(
    this: WithChoicesIOPromise<
      MethodName,
      Props,
      ComponentOutput,
      MultipleableIOPromise<MethodName, Props, ComponentOutput, DefaultValue>,
      Choice
    >,
    {
      defaultValue,
    }: {
      defaultValue?: DefaultValue[] | null
    } = {}
  ): WithChoicesIOPromise<
    MethodName,
    Props,
    ComponentOutput[],
    MultipleIOPromise<MethodName, Props, ComponentOutput>,
    Choice
  > {
    if (!(this.innerPromise instanceof MultipleableIOPromise)) {
      throw new UtilHQError(
        `Invalid chained method call: .multiple() is not allowed on the IO method with label "${this.component.label}".`
      )
    }

    return new WithChoicesIOPromise({
      innerPromise: this.innerPromise.multiple({ defaultValue }),
      choiceButtons: this.choiceButtons as (ChoiceButtonConfig & {
        value: Choice
      })[],
    })
  }

  withChoices<NewChoice extends string>(
    choices: ChoiceButtonConfigOrShorthand<NewChoice>[]
  ): WithChoicesIOPromise<MethodName, Props, ComponentOutput, InnerPromise, NewChoice> {
    return new WithChoicesIOPromise<
      MethodName,
      Props,
      ComponentOutput,
      InnerPromise,
      NewChoice
    >({
      innerPromise: this.innerPromise,
      choiceButtons: choices,
    })
  }
}

/**
 * A thin subclass of IOPromise that does nothing but mark the component
 * as "exclusive" for components that cannot be rendered in a group.
 * Also cannot be optional at this time.
 */
export class ExclusiveIOPromise<
  MethodName extends T_IO_INPUT_METHOD_NAMES,
  Props extends T_IO_PROPS<MethodName> = T_IO_PROPS<MethodName>,
  ComponentOutput = ComponentReturnValue<MethodName>
> extends IOPromise<MethodName, Props, ComponentOutput> {
  get component() {
    return new IOComponent({
      methodName: this.methodName,
      label: this.label,
      initialProps: this.props,
      onStateChange: this.onStateChange,
      isOptional: false,
      validator: this.validator ? this.handleValidation.bind(this) : undefined,
      displayResolvesImmediately: this.displayResolvesImmediately,
      onPropsUpdate: this.onPropsUpdate,
    })
  }

  /* @internal */ async handleValidation(
    returnValue: MaybeMultipleComponentReturnValue<MethodName> | undefined
  ): Promise<string | undefined> {
    // These should be caught already, primarily here for types
    if (returnValue === undefined) {
      return 'This field is required.'
    }

    const parsed = ioSchema[this.methodName].returns.safeParse(returnValue)
    if (parsed.success) {
      if (this.validator) {
        return this.validator(this.getValue(parsed.data))
      }
    } else {
      // shouldn't be hit, but just in case
      return 'Received invalid value for field.'
    }
  }

  validate(validator: IOPromiseValidator<ComponentOutput>): this {
    this.validator = validator

    return this
  }
}

export type IOGroupReturnValues<
  IOPromises extends
    | Record<string, MaybeOptionalGroupIOPromise>
    | [MaybeOptionalGroupIOPromise, ...MaybeOptionalGroupIOPromise[]]
> = {
  [Idx in keyof IOPromises]: IOPromises[Idx] extends
    | GroupIOPromise
    | OptionalGroupIOPromise
    ? ReturnType<IOPromises[Idx]['getValue']>
    : IOPromises[Idx]
}

export type IOGroupComponents<
  IOPromises extends [
    MaybeOptionalGroupIOPromise,
    ...MaybeOptionalGroupIOPromise[]
  ]
> = {
  [Idx in keyof IOPromises]: IOPromises[Idx] extends
    | GroupIOPromise
    | OptionalGroupIOPromise
    ? IOPromises[Idx]['component']
    : IOPromises[Idx]
}

export type IOPromiseValidator<ComponentOutput> = (
  returnValue: ComponentOutput
) => string | undefined | Promise<string | undefined>

export type WithChoicesIOPromiseValidator<
  Choice extends string,
  ComponentOutput
> = (props: {
  choice: Choice
  returnValue: ComponentOutput
}) => string | undefined | Promise<string | undefined>

export class IOGroupPromise<
  IOPromises extends
    | Record<string, MaybeOptionalGroupIOPromise>
    | MaybeOptionalGroupIOPromise[],
  ReturnValues = IOPromises extends Record<string, MaybeOptionalGroupIOPromise>
    ? { [K in keyof IOPromises]: ReturnType<IOPromises[K]['getValue']> }
    : IOPromises extends [
        MaybeOptionalGroupIOPromise,
        ...MaybeOptionalGroupIOPromise[]
      ]
    ? IOGroupReturnValues<IOPromises>
    : unknown[]
> {
  /* @internal */ promises: IOPromises
  /* @internal */ renderer: ComponentsRenderer
  /* @internal */ validator: IOPromiseValidator<ReturnValues> | undefined

  #choiceButtons: ChoiceButtonConfig[] | undefined

  constructor(config: {
    promises: IOPromises
    renderer: ComponentsRenderer
    /** @deprecated Please use the chained .withSubmit() method instead. */
    continueButton?: ButtonConfig
  }) {
    this.promises = config.promises
    this.renderer = config.renderer
    this.#choiceButtons = config.continueButton
      ? [
          {
            label: config.continueButton.label ?? 'Continue',
            value: config.continueButton.label ?? 'Continue',
            theme: config.continueButton.theme,
          },
        ]
      : undefined
  }

  /* @internal */ get components(): [AnyIOComponent, ...AnyIOComponent[]] {
    return this.promiseValues.map(p => p.component) as unknown as [
      AnyIOComponent,
      ...AnyIOComponent[]
    ]
  }

  /* @internal */ get promiseValues(): MaybeOptionalGroupIOPromise[] {
    return Array.isArray(this.promises)
      ? this.promises
      : Object.values(this.promises)
  }

  then(
    resolve: (output: ReturnValues) => void,
    reject?: (err: IOError) => void
  ) {
    this.renderer({
      components: this.components,
      validator: this.validator ? this.handleValidation.bind(this) : undefined,
      choiceButtons: this.#choiceButtons,
    })
      .then(response => {
        resolve(this.getValues(response))
      })
      .catch(err => {
        if (reject) reject(err)
      })
  }

  /* @internal */ getValues({
    returnValue,
  }: ComponentsRendererReturn<
    [AnyIOComponent, ...AnyIOComponent[]]
  >): ReturnValues {
    let returnValues = returnValue.map((val, i) =>
      this.promiseValues[i].getValue(val as never)
    )

    if (Array.isArray(this.promises)) {
      return returnValues as unknown as ReturnValues
    } else {
      const keys = Object.keys(this.promises)
      return Object.fromEntries(
        returnValues.map((val, i) => [keys[i], val])
      ) as ReturnValues
    }
  }

  validate(validator: IOPromiseValidator<ReturnValues> | undefined): this {
    this.validator = validator

    return this
  }

  // These types aren't as tight as they could be, but
  // TypeScript doesn't like IOGroupComponents defined above here
  /* @internal */ async handleValidation(
    returnValues: IOClientRenderReturnValues<
      [AnyIOComponent, ...AnyIOComponent[]]
    >
  ): Promise<string | undefined> {
    if (!this.validator) return

    const promiseValues = this.promiseValues

    const values = returnValues.returnValue.map((v, index) =>
      promiseValues[index].getValue(v as never)
    )

    if (Array.isArray(this.promises)) {
      return this.validator(values as unknown as ReturnValues)
    } else {
      const keys = Object.keys(this.promises)
      const valueMap = Object.fromEntries(
        values.map((val, i) => [keys[i], val])
      )

      return this.validator(valueMap as ReturnValues)
    }
  }

  withChoices<Choice extends string>(
    choices: ChoiceButtonConfigOrShorthand<Choice>[]
  ): WithChoicesIOGroupPromise<IOPromises, ReturnValues, IOGroupPromise<IOPromises, ReturnValues>, Choice> {
    return new WithChoicesIOGroupPromise<
      IOPromises,
      ReturnValues,
      IOGroupPromise<IOPromises, ReturnValues>,
      Choice
    >({
      innerPromise: this,
      choiceButtons: choices,
      validator: this.validator,
    })
  }
}

export class WithChoicesIOGroupPromise<
  IOPromises extends
    | Record<string, MaybeOptionalGroupIOPromise>
    | MaybeOptionalGroupIOPromise[],
  ReturnValues = IOPromises extends Record<string, MaybeOptionalGroupIOPromise>
    ? { [K in keyof IOPromises]: ReturnType<IOPromises[K]['getValue']> }
    : IOPromises extends [
        MaybeOptionalGroupIOPromise,
        ...MaybeOptionalGroupIOPromise[]
      ]
    ? IOGroupReturnValues<IOPromises>
    : unknown[],
  InnerPromise extends IOGroupPromise<
    IOPromises,
    ReturnValues
  > = IOGroupPromise<IOPromises, ReturnValues>,
  Choice extends string = string
> {
  #innerPromise: InnerPromise
  #choiceButtons: ChoiceButtonConfig[] | undefined
  /* @internal */ validator:
    | WithChoicesIOPromiseValidator<Choice, ReturnValues>
    | undefined

  constructor(config: {
    innerPromise: InnerPromise
    choiceButtons?: ChoiceButtonConfigOrShorthand<Choice>[]
    validator?: IOPromiseValidator<ReturnValues>
  }) {
    this.#innerPromise = config.innerPromise
    this.#choiceButtons = config.choiceButtons?.map(b =>
      typeof b === 'string'
        ? { label: b as string, value: b as string }
        : (b as ChoiceButtonConfig)
    )

    const innerValidator = config.validator
    if (innerValidator) {
      this.validator = ({ choice, returnValue }) => {
        return innerValidator(returnValue)
      }
    }
  }

  then(
    resolve: (output: { choice: Choice; returnValue: ReturnValues }) => void,
    reject?: (err: IOError) => void
  ) {
    this.#innerPromise
      .renderer({
        components: this.#innerPromise.components,
        validator: this.validator
          ? this.handleValidation.bind(this)
          : undefined,
        choiceButtons: this.#choiceButtons,
      })
      .then(response => {
        const returnValue = this.#innerPromise.getValues(response)
        resolve({
          choice: response.choice as Choice,
          returnValue,
        })
      })
      .catch(err => {
        if (reject) reject(err)
      })
  }

  validate(
    validator: WithChoicesIOPromiseValidator<Choice, ReturnValues> | undefined
  ): this {
    this.validator = validator
    return this
  }

  // These types aren't as tight as they could be, but
  // TypeScript doesn't like IOGroupComponents defined above here
  /* @internal */ async handleValidation(
    returnValues: IOClientRenderReturnValues<
      [AnyIOComponent, ...AnyIOComponent[]]
    >
  ): Promise<string | undefined> {
    if (!this.validator) return

    const promiseValues = this.#innerPromise.promiseValues

    const values = returnValues.returnValue.map((v, index) =>
      promiseValues[index].getValue(v as never)
    )

    if (Array.isArray(this.#innerPromise.promises)) {
      return this.validator({
        choice: returnValues.choice as Choice,
        returnValue: values as unknown as ReturnValues,
      })
    } else {
      const keys = Object.keys(this.#innerPromise.promises)
      const valueMap = Object.fromEntries(
        values.map((val, i) => [keys[i], val])
      )

      return this.validator({
        choice: returnValues.choice as Choice,
        returnValue: valueMap as ReturnValues,
      })
    }
  }

  withChoices<Choice extends string>(
    choices: ChoiceButtonConfigOrShorthand<Choice>[]
  ) {
    return new WithChoicesIOGroupPromise<
      IOPromises,
      ReturnValues,
      InnerPromise,
      Choice
    >({
      innerPromise: this.#innerPromise,
      choiceButtons: choices,
    })
  }
}

